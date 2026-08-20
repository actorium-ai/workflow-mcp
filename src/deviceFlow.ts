/**
 * Device-flow HTTP client for the `pair` subcommand (see pair.ts).
 *
 * The local agent is the device-flow INITIATOR: it starts the grant, prints
 * the `user_code`, and is the party that redeems the `device_code` — the web
 * UI at `/device-authorize` is the approval side only. Endpoints are served
 * by the workflow BFF directly (not proxied through another upstream):
 *
 *   POST /oauth/device        — issue device_code / user_code
 *   POST /oauth/device/token  — exchange device_code (or refresh_token)
 */

/** `client_id` identifying this pairing client to the device grant. */
export const PAIRING_CLIENT_ID = 'actorium-local-agent';

/** OAuth 2.0 device authorization grant type, per RFC 8628. */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
export const REFRESH_GRANT_TYPE = 'refresh_token';

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export interface StartDeviceFlowOptions {
  client_id: string;
  handle: string;
}

/** Failure carrying the OAuth `error` code when one was returned. */
export class DeviceFlowError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'DeviceFlowError';
  }
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_DEADLINE_MS = 600_000;

function baseUrl(bffUrl: string): string {
  return bffUrl.replace(/\/$/, '');
}

function readErrorBody(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const code = (parsed as Record<string, unknown>).error;
      return typeof code === 'string' ? code : undefined;
    }
  } catch {
    // not JSON — fall through
  }
  return undefined;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    const code = readErrorBody(text) ?? String(response.status);
    throw new DeviceFlowError(`Device authorization request failed: ${code}`, code);
  }

  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text || undefined;
  }
  return parsed as T;
}

/**
 * Starts the device authorization grant: POST /oauth/device.
 * Returns the codes the initiator must redeem (and show to the human).
 */
export async function start(bffUrl: string, options: StartDeviceFlowOptions): Promise<DeviceCodeResponse> {
  return postJson<DeviceCodeResponse>(`${baseUrl(bffUrl)}/oauth/device`, options);
}

/**
 * Exchanges a `device_code` for tokens: POST /oauth/device/token.
 * Throws a DeviceFlowError carrying the OAuth `error` code while the grant is
 * pending/denied/expired (see pollAndExchange, which retries the pending case).
 */
export async function exchange(bffUrl: string, deviceCode: string, clientId: string): Promise<TokenResponse> {
  return postJson<TokenResponse>(`${baseUrl(bffUrl)}/oauth/device/token`, {
    grant_type: DEVICE_CODE_GRANT_TYPE,
    device_code: deviceCode,
    client_id: clientId,
  });
}

/**
 * Refreshes an expired/expiring access token: POST /oauth/device/token with
 * grant_type=refresh_token. Revocation is checked server-side here (a revoked
 * refresh token yields `invalid_grant`).
 */
export async function refresh(bffUrl: string, refreshToken: string): Promise<TokenResponse> {
  return postJson<TokenResponse>(`${baseUrl(bffUrl)}/oauth/device/token`, {
    grant_type: REFRESH_GRANT_TYPE,
    refresh_token: refreshToken,
  });
}

export interface PollOptions {
  intervalMs?: number;
  deadlineMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the token endpoint until the human approves the grant or the grant
 * ends. `authorization_pending`/`slow_down` retry after the interval (RFC 8628);
 * any other error (access_denied, expired_token, invalid_grant, ...) throws.
 * Bounded by `deadlineMs` so a never-approved grant cannot poll forever.
 */
export async function pollAndExchange(
  bffUrl: string,
  deviceCode: string,
  clientId: string,
  options: PollOptions = {},
): Promise<TokenResponse> {
  let interval = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options.deadlineMs ?? DEFAULT_POLL_DEADLINE_MS);

  for (;;) {
    try {
      return await exchange(bffUrl, deviceCode, clientId);
    } catch (err) {
      if (!(err instanceof DeviceFlowError)) throw err;
      if (err.code === 'authorization_pending') {
        // retry after interval
      } else if (err.code === 'slow_down') {
        interval += 5_000;
      } else {
        throw err;
      }
    }

    if (Date.now() + interval >= deadline) {
      throw new DeviceFlowError(
        'Device authorization expired before the code was approved.',
        'expired_token',
      );
    }
    await sleep(interval);
  }
}
