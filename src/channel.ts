import { Config } from './config.js';

/**
 * The local agent holds a "channel" to workflow-chat-agent while the
 * actorium-mcp server is running: an SSE subscription (wake hint only) plus a
 * periodic presence heartbeat (lease + last_seen only). Both are authenticated
 * with the same login bearer token every other tool call already uses (see
 * config.ts) — its `agent_participant_id` claim (the caller's own user id)
 * identifies the participant in every URL. All chat-agent routes live under
 * `/api/v1`; through the BFF they are `/bff/hermes-agent/api/v1/...`
 * (technical design §Constraints 8).
 */
const HERMES_AGENT_PREFIX = '/bff/hermes-agent/api/v1';

/**
 * Presence heartbeat cadence (ms). The server's presence lease is 90s, so a
 * 30s cadence keeps it warm with margin while staying well under the lease.
 */
export const PRESENCE_HEARTBEAT_MS = 30_000;

/** Delay before re-opening a dropped SSE subscription. */
const SSE_RECONNECT_DELAY_MS = 5_000;

export interface ChannelOptions {
  /** Presence heartbeat cadence in ms (default PRESENCE_HEARTBEAT_MS). */
  heartbeatMs?: number;
  /** fetch seam for tests (default global fetch). */
  fetch?: typeof fetch;
  /** Receives each parsed SSE event (best-effort wake hint). Default: no-op. */
  onEvent?: (event: unknown) => void;
  /** SSE reconnect delay in ms (default SSE_RECONNECT_DELAY_MS). */
  reconnectMs?: number;
}

export interface ChannelHandle {
  /** Stops the heartbeat interval and aborts the SSE subscription. */
  stop(): void;
}

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * Reads the `agent_participant_id` claim out of an access token's JWT
 * payload. The payload is base64url-encoded JSON and is read WITHOUT signature
 * verification — the server re-verifies the token on every call, and this value
 * is only used to build the participant-scoped URLs the caller already owns.
 * Returns null when the token is malformed or the claim is absent/empty.
 */
export function participantIdFromAccessToken(accessToken: string): string | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>;
    const id = payload['agent_participant_id'];
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Reads the `exp` claim (ms since epoch) out of an access token, without
 * signature verification — same rationale as participantIdFromAccessToken.
 * Not used for any local renewal decision (see resolveParticipant's doc
 * comment) — kept as a small decode utility for callers/tests that want it.
 */
export function expiryFromAccessToken(accessToken: string): number | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>;
    const exp = payload['exp'];
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** The local-agent identity a channel/review tool acts as. */
export interface ResolvedParticipant {
  participantId: string;
  accessToken: string;
}

/**
 * Resolves the local-agent participant straight from the login bearer token
 * — the same token `tools.ts`/`BffClient` already use (see config.ts). There
 * is no separate pairing file and no local refresh to manage: the VS Code
 * extension keeps the underlying credential fresh in the background, and
 * `loadConfig()` is cheap enough to call fresh per use (see its doc comment),
 * so callers simply re-resolve `Config` when they want up-to-date identity
 * rather than this function renewing anything itself.
 *
 * Returns null when there is no bearer token, or its JWT carries no
 * `agent_participant_id` claim (e.g. a backend not yet minting the claim, or
 * a WORKFLOW_TOKEN sourced from something other than a real login) — callers
 * treat that as "not logged in".
 */
export function resolveParticipant(config: Config): ResolvedParticipant | null {
  if (!config.bearerToken) return null;
  const participantId = participantIdFromAccessToken(config.bearerToken);
  if (!participantId) return null;
  return { participantId, accessToken: config.bearerToken };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function ignoreEvent(_event: unknown): void {
  // default onEvent — the SSE stream is a hint only; events are discarded.
}

/**
 * Extracts JSON `data:` payloads from one SSE event frame (a block terminated
 * by a blank line). Non-`data:` lines and non-JSON payloads are ignored — the
 * stream is a best-effort hint, so a malformed line is never fatal.
 */
export function parseSseData(frame: string): unknown[] {
  const events: unknown[] = [];
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice('data:'.length).trim();
    if (!raw) continue;
    try {
      events.push(JSON.parse(raw));
    } catch {
      // best-effort hint — a non-JSON data line is ignored, not fatal
    }
  }
  return events;
}

/**
 * Reads an SSE response stream to completion, invoking `onEvent` for every
 * parsed event. Returns quietly when the stream ends, is aborted, or errors —
 * the SSE stream is a wake hint; the pending-turn poll endpoint is the source
 * of truth (the realtime bus drops on QueueFull with no replay).
 */
export async function consumeSseStream(
  response: Response,
  onEvent: (event: unknown) => void,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const event of parseSseData(frame)) {
          try {
            onEvent(event);
          } catch {
            // a listener error must not kill the hint channel
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch (err) {
    if (!isAbortError(err)) {
      // stream dropped mid-read — best-effort hint; the poll endpoint is authoritative
    }
  }
}

/**
 * Opens the SSE subscription once and reads it to completion. `authorize` is
 * called per attempt rather than once per channel so a reconnect after a
 * rotated login token carries a fresh one.
 */
async function subscribeEvents(
  fetchImpl: typeof fetch,
  url: string,
  authorize: () => Promise<Record<string, string> | null>,
  signal: AbortSignal,
  onEvent: (event: unknown) => void,
): Promise<void> {
  try {
    const headers = await authorize();
    if (!headers) return;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...headers },
      signal,
    });
    if (!response.ok) return;
    await consumeSseStream(response, onEvent);
  } catch (err) {
    if (!isAbortError(err)) {
      // dropped before the stream opened — best-effort hint channel
    }
  }
}

/**
 * Keeps the SSE subscription open for the life of the channel, re-opening it
 * after each drop until the channel is stopped. Without this the stream is a
 * one-shot: the first drop (a proxy idle timeout, a deploy, or a 401) would
 * silently end the wake hints for the rest of the process's life.
 */
async function subscribeWithReconnect(
  fetchImpl: typeof fetch,
  url: string,
  authorize: () => Promise<Record<string, string> | null>,
  signal: AbortSignal,
  onEvent: (event: unknown) => void,
  reconnectMs: number,
): Promise<void> {
  while (!signal.aborted) {
    await subscribeEvents(fetchImpl, url, authorize, signal, onEvent);
    if (signal.aborted) return;
    await sleepUnlessAborted(reconnectMs, signal);
  }
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    // The reconnect backoff must never be the reason the process stays alive —
    // an idle agent should exit when its work is done, not linger for a hint
    // channel. (unref is absent under jest's fake timers.)
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/**
 * Starts the local agent's channel: an SSE subscription to the participant's
 * event stream (wake hint only) plus a 30s presence heartbeat (lease/last_seen
 * only). Returns null — without starting any timers or connections — when
 * there is no usable login (no bearer token, or a token whose JWT carries no
 * `agent_participant_id` claim), so a logged-out server run is a clean no-op.
 * The returned handle's stop() tears the channel down.
 *
 * `getConfig` is re-invoked (not just once at startup) for every heartbeat
 * and every SSE (re)connect, so a login token rotated in the background by
 * the VS Code extension is picked up without restarting this process.
 */
export function startChannel(getConfig: () => Config, options: ChannelOptions = {}): ChannelHandle | null {
  const config = getConfig();
  const participant = resolveParticipant(config);
  if (!participant) return null;

  const fetchImpl = options.fetch ?? fetch;
  const heartbeatMs = options.heartbeatMs ?? PRESENCE_HEARTBEAT_MS;
  const onEvent = options.onEvent ?? ignoreEvent;

  const baseUrl = config.bffUrl.replace(/\/$/, '');
  const participantId = encodeURIComponent(participant.participantId);

  const presenceUrl = `${baseUrl}${HERMES_AGENT_PREFIX}/participants/${participantId}/presence`;
  const eventsUrl = `${baseUrl}${HERMES_AGENT_PREFIX}/participants/${participantId}/events`;

  // Resolved per request, not captured once: the underlying login token can
  // rotate while this server stays up, so re-reading getConfig() here picks
  // that up immediately — the same rationale as BffClient's per-request
  // getConfig() call.
  const authorize = async (): Promise<Record<string, string> | null> => {
    const fresh = resolveParticipant(getConfig());
    if (!fresh) return null;
    return { Authorization: `Bearer ${fresh.accessToken}` };
  };

  const heartbeat = async (): Promise<void> => {
    try {
      const headers = await authorize();
      if (!headers) return;
      await fetchImpl(presenceUrl, { method: 'POST', headers });
    } catch {
      // best-effort: a failed heartbeat simply lets the presence lease lapse
    }
  };

  const interval = setInterval(() => {
    void heartbeat();
  }, heartbeatMs);

  const controller = new AbortController();
  void subscribeWithReconnect(
    fetchImpl,
    eventsUrl,
    authorize,
    controller.signal,
    onEvent,
    options.reconnectMs ?? SSE_RECONNECT_DELAY_MS,
  );

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      controller.abort();
    },
  };
}
