import * as os from 'os';

import { loadConfig } from './config.js';
import * as deviceFlow from './deviceFlow.js';
import type { TokenResponse } from './deviceFlow.js';
import { loadPairing, PairingCredentials, savePairing } from './pairingStore.js';

/** Refresh this far before the access token actually expires. */
const REFRESH_MARGIN_MS = 60_000;

/** Default pairing handle when `--handle` is omitted — the OS username. */
export function defaultHandle(): string {
  return os.userInfo().username;
}

/** Parses `--handle <value>` or `--handle=<value>` out of the pair args. */
export function parseHandle(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--handle') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) return next;
      return undefined;
    }
    if (arg.startsWith('--handle=')) {
      return arg.slice('--handle='.length) || undefined;
    }
  }
  return undefined;
}

function accessTokenExpiry(creds: PairingCredentials): number {
  const expiresInMs = (creds.expiresIn ?? 3600) * 1000;
  return creds.updatedAt + expiresInMs;
}

function needsRefresh(creds: PairingCredentials): boolean {
  return Date.now() >= accessTokenExpiry(creds) - REFRESH_MARGIN_MS;
}

function toCredentials(
  tokens: TokenResponse,
  clientId: string,
  handle: string,
  bffUrl: string,
): PairingCredentials {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    tokenType: tokens.token_type,
    clientId,
    handle,
    bffUrl,
    updatedAt: Date.now(),
  };
}

function printStatus(creds: PairingCredentials): void {
  const expiry = new Date(accessTokenExpiry(creds)).toISOString();
  process.stdout.write(`Paired as @${creds.handle ?? 'local-agent'}\n`);
  process.stdout.write(`  access token expires: ${expiry}\n`);
}

/**
 * The `pair` subcommand. Initiates the device grant as a first-class
 * device-flow client: if a valid pairing already exists (and a refresh, when
 * needed, succeeds), print its status and exit — else start a fresh grant,
 * print the user_code + approval URL, poll-and-exchange the device_code, and
 * persist the credentials (incl. refresh_token) to the pairing file.
 */
export async function runPair(args: string[]): Promise<void> {
  const config = loadConfig();
  const bffUrl = config.bffUrl;
  const handle = parseHandle(args) ?? defaultHandle();

  const existing = loadPairing(bffUrl);
  if (existing) {
    if (!needsRefresh(existing)) {
      printStatus(existing);
      return;
    }
    try {
      const tokens = await deviceFlow.refresh(bffUrl, existing.refreshToken);
      const creds = toCredentials(
        tokens,
        existing.clientId ?? deviceFlow.PAIRING_CLIENT_ID,
        existing.handle ?? handle,
        bffUrl,
      );
      savePairing(bffUrl, creds);
      printStatus(creds);
      return;
    } catch {
      // refresh failed (e.g. revoked/expired) — fall through to a fresh pairing
    }
  }

  const started = await deviceFlow.start(bffUrl, {
    client_id: deviceFlow.PAIRING_CLIENT_ID,
    handle,
  });
  process.stdout.write(`Open ${started.verification_uri} and enter code: ${started.user_code}\n`);

  const tokens = await deviceFlow.pollAndExchange(
    bffUrl,
    started.device_code,
    deviceFlow.PAIRING_CLIENT_ID,
    {
      intervalMs: (started.interval ?? 5) * 1000,
      deadlineMs: (started.expires_in ?? 600) * 1000,
    },
  );

  const creds = toCredentials(tokens, deviceFlow.PAIRING_CLIENT_ID, handle, bffUrl);
  savePairing(bffUrl, creds);
  printStatus(creds);
}
