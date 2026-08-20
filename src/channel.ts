import * as os from 'os';

import { Config } from './config.js';
import { loadPairing } from './pairingStore.js';

/**
 * The paired local agent holds a "channel" to workflow-chat-agent while the
 * actorium-mcp server is running: an SSE subscription (wake hint only) plus a
 * periodic presence heartbeat (lease + last_seen only). Both are authenticated
 * with the pairing access token, whose `agent_participant_id` claim identifies
 * the participant in every URL. All chat-agent routes live under `/api/v1`;
 * through the BFF they are `/bff/hermes-agent/api/v1/...` (technical design
 * §Constraints 8).
 */
const HERMES_AGENT_PREFIX = '/bff/hermes-agent/api/v1';

/**
 * Presence heartbeat cadence (ms). The server's presence lease is 90s, so a
 * 30s cadence keeps it warm with margin while staying well under the lease.
 */
export const PRESENCE_HEARTBEAT_MS = 30_000;

export interface ChannelOptions {
  /** Presence heartbeat cadence in ms (default PRESENCE_HEARTBEAT_MS). */
  heartbeatMs?: number;
  /** Home-dir seam for locating the pairing file (default os.homedir()). */
  homeDir?: string;
  /** fetch seam for tests (default global fetch). */
  fetch?: typeof fetch;
  /** Receives each parsed SSE event (best-effort wake hint). Default: no-op. */
  onEvent?: (event: unknown) => void;
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
 * Reads the `agent_participant_id` claim out of a pairing access token's JWT
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

/** The paired identity a channel/review tool acts as. */
export interface ResolvedParticipant {
  participantId: string;
  accessToken: string;
}

/**
 * Resolves the paired local-agent participant from `pairing.<hash>.json` —
 * the pairing file ONLY (it identifies the participant; `auth.<hash>.json` is
 * the developer's own user token). Returns null when there is no usable pairing
 * (missing file, or an access token without an `agent_participant_id` claim),
 * which callers treat as "not paired".
 */
export function resolveParticipant(config: Config, homeDir?: string): ResolvedParticipant | null {
  const pairing = loadPairing(config.bffUrl, homeDir ?? os.homedir());
  if (!pairing) return null;
  const participantId = participantIdFromAccessToken(pairing.accessToken);
  if (!participantId) return null;
  return { participantId, accessToken: pairing.accessToken };
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

async function subscribeEvents(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  onEvent: (event: unknown) => void,
): Promise<void> {
  try {
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
 * Starts the paired local agent's channel: an SSE subscription to the
 * participant's event stream (wake hint only) plus a 30s presence heartbeat
 * (lease/last_seen only). Returns null — without starting any timers or
 * connections — when there is no usable pairing, so an unpaired server run is a
 * clean no-op. The returned handle's stop() tears the channel down.
 */
export function startChannel(config: Config, options: ChannelOptions = {}): ChannelHandle | null {
  const participant = resolveParticipant(config, options.homeDir);
  if (!participant) return null;

  const fetchImpl = options.fetch ?? fetch;
  const heartbeatMs = options.heartbeatMs ?? PRESENCE_HEARTBEAT_MS;
  const onEvent = options.onEvent ?? ignoreEvent;

  const baseUrl = config.bffUrl.replace(/\/$/, '');
  const participantId = encodeURIComponent(participant.participantId);
  const authHeaders = { Authorization: `Bearer ${participant.accessToken}` };

  const presenceUrl = `${baseUrl}${HERMES_AGENT_PREFIX}/participants/${participantId}/presence`;
  const eventsUrl = `${baseUrl}${HERMES_AGENT_PREFIX}/participants/${participantId}/events`;

  const heartbeat = async (): Promise<void> => {
    try {
      await fetchImpl(presenceUrl, { method: 'POST', headers: authHeaders });
    } catch {
      // best-effort: a failed heartbeat simply lets the presence lease lapse
    }
  };

  const interval = setInterval(() => {
    void heartbeat();
  }, heartbeatMs);

  const controller = new AbortController();
  void subscribeEvents(fetchImpl, eventsUrl, authHeaders, controller.signal, onEvent);

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
