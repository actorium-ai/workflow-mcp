import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  consumeSseStream,
  expiryFromAccessToken,
  parseSseData,
  participantIdFromAccessToken,
  resolveFreshParticipant,
  resolveParticipant,
  startChannel,
} from './channel';
import { loadPairing, savePairing } from './pairingStore';

const BFF = 'http://bff.example.com';
const CONFIG = { bffUrl: BFF };

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makeAccessToken(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.signature`;
}

const ACCESS_TOKEN = makeAccessToken({ agent_participant_id: 'participant-123' });

function writePairing(homeDir: string, accessToken: string = ACCESS_TOKEN): void {
  savePairing(
    BFF,
    {
      accessToken,
      refreshToken: 'refresh-1',
      expiresIn: 3600,
      handle: 'dev-agent',
      clientId: 'actorium-local-agent',
      bffUrl: BFF,
      updatedAt: Date.now(),
    },
    homeDir,
  );
}

function makeResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    body: undefined,
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: stream,
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

describe('participantIdFromAccessToken', () => {
  it('decodes agent_participant_id from the JWT payload', () => {
    expect(participantIdFromAccessToken(ACCESS_TOKEN)).toBe('participant-123');
  });

  it('returns null when the token has fewer than three dot-separated parts', () => {
    expect(participantIdFromAccessToken('header.payload')).toBeNull();
  });

  it('returns null when the claim is absent', () => {
    expect(participantIdFromAccessToken(makeAccessToken({ sub: 'user-1' }))).toBeNull();
  });

  it('returns null when the claim is empty', () => {
    expect(participantIdFromAccessToken(makeAccessToken({ agent_participant_id: '' }))).toBeNull();
  });

  it('returns null when the payload is not valid JSON', () => {
    const header = b64url({ alg: 'HS256' });
    const bad = Buffer.from('not-json').toString('base64');
    expect(participantIdFromAccessToken(`${header}.${bad}.sig`)).toBeNull();
  });
});

describe('parseSseData', () => {
  it('extracts every JSON data payload in a frame', () => {
    expect(parseSseData('data: {"a":1}\ndata: {"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('ignores non-data lines (event names and comments)', () => {
    expect(parseSseData('event: review_turn_requested\n: keep-alive\ndata: {"a":1}')).toEqual([
      { a: 1 },
    ]);
  });

  it('ignores non-JSON data lines', () => {
    expect(parseSseData('data: not-json\ndata: {"a":1}')).toEqual([{ a: 1 }]);
  });

  it('returns an empty array for an empty frame', () => {
    expect(parseSseData('')).toEqual([]);
  });
});

describe('consumeSseStream', () => {
  it('parses and delivers each SSE event in the stream', async () => {
    const events: unknown[] = [];
    const response = sseResponse([
      'event: review_turn_requested\ndata: {"session_id":"s1","prompt":"hi"}\n\n',
      'data: {"session_id":"s2"}\n\n',
    ]);

    await consumeSseStream(response, (event) => events.push(event));

    expect(events).toEqual([
      { session_id: 's1', prompt: 'hi' },
      { session_id: 's2' },
    ]);
  });

  it('handles an event split across stream chunks', async () => {
    const events: unknown[] = [];
    const response = sseResponse(['data: {"se', 'ssion_id":"split"}\n\n']);

    await consumeSseStream(response, (event) => events.push(event));

    expect(events).toEqual([{ session_id: 'split' }]);
  });

  it('ignores non-JSON and non-data lines while delivering real events', async () => {
    const events: unknown[] = [];
    const response = sseResponse([
      ': keep-alive\n\nevent: review_turn_requested\ndata: {"x":1}\ndata: not-json\n\n',
    ]);

    await consumeSseStream(response, (event) => events.push(event));

    expect(events).toEqual([{ x: 1 }]);
  });

  it('returns immediately when the response has no body', async () => {
    const onEvent = jest.fn();
    await consumeSseStream(makeResponse(200), onEvent);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe('resolveParticipant', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'actorium-channel-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns null when there is no pairing file', () => {
    expect(resolveParticipant(CONFIG, tempHome)).toBeNull();
  });

  it('returns the participant id and access token when paired', () => {
    writePairing(tempHome);
    expect(resolveParticipant(CONFIG, tempHome)).toEqual({
      participantId: 'participant-123',
      accessToken: ACCESS_TOKEN,
    });
  });

  it('returns null when the access token lacks agent_participant_id', () => {
    writePairing(tempHome, makeAccessToken({ sub: 'user-1' }));
    expect(resolveParticipant(CONFIG, tempHome)).toBeNull();
  });
});

describe('resolveFreshParticipant', () => {
  let tempHome: string;

  const FRESH_TOKEN = makeAccessToken({
    agent_participant_id: 'participant-123',
    exp: 4_000,
  });
  const EXPIRING_TOKEN = makeAccessToken({
    agent_participant_id: 'participant-123',
    exp: 1_030,
  });
  const RENEWED_TOKEN = makeAccessToken({
    agent_participant_id: 'participant-456',
    exp: 9_000,
  });

  // 1_000_000ms == exp 1_000s, so EXPIRING_TOKEN has 30s left (inside the skew)
  // and FRESH_TOKEN has ~50min (outside it).
  const now = (): number => 1_000_000;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'actorium-fresh-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns null when there is no pairing', async () => {
    const refresh = jest.fn();
    const result = await resolveFreshParticipant(CONFIG, { homeDir: tempHome, refresh, now });
    expect(result).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('uses the stored token without refreshing when it is not near expiry', async () => {
    writePairing(tempHome, FRESH_TOKEN);
    const refresh = jest.fn();

    const result = await resolveFreshParticipant(CONFIG, { homeDir: tempHome, refresh, now });

    expect(refresh).not.toHaveBeenCalled();
    expect(result).toEqual({ participantId: 'participant-123', accessToken: FRESH_TOKEN });
  });

  it('renews and persists both tokens when the access token is near expiry', async () => {
    writePairing(tempHome, EXPIRING_TOKEN);
    const refresh = jest.fn().mockResolvedValue({
      access_token: RENEWED_TOKEN,
      refresh_token: 'refresh-2',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    const result = await resolveFreshParticipant(CONFIG, { homeDir: tempHome, refresh, now });

    // client_id must be sent: the BFF routes to the pairing store on it
    expect(refresh).toHaveBeenCalledWith(BFF, 'refresh-1', 'actorium-local-agent');
    expect(result).toEqual({ participantId: 'participant-456', accessToken: RENEWED_TOKEN });

    // the rotated refresh token is persisted — the old one is single-use
    const stored = loadPairing(BFF, tempHome);
    expect(stored?.accessToken).toBe(RENEWED_TOKEN);
    expect(stored?.refreshToken).toBe('refresh-2');
  });

  it('falls back to the stored token when renewal fails', async () => {
    writePairing(tempHome, EXPIRING_TOKEN);
    const refresh = jest.fn().mockRejectedValue(new Error('offline'));

    const result = await resolveFreshParticipant(CONFIG, { homeDir: tempHome, refresh, now });

    // the server's own 401 is the accurate signal — don't guess locally
    expect(result).toEqual({ participantId: 'participant-123', accessToken: EXPIRING_TOKEN });
    expect(loadPairing(BFF, tempHome)?.refreshToken).toBe('refresh-1');
  });
});

describe('expiryFromAccessToken', () => {
  it('returns the exp claim in milliseconds', () => {
    expect(expiryFromAccessToken(makeAccessToken({ exp: 1_700 }))).toBe(1_700_000);
  });

  it('returns null when there is no numeric exp', () => {
    expect(expiryFromAccessToken(makeAccessToken({}))).toBeNull();
    expect(expiryFromAccessToken('not-a-jwt')).toBeNull();
  });
});

describe('startChannel', () => {
  let tempHome: string;
  let mockFetch: jest.Mock;

  const fetchOptions = () => ({ fetch: mockFetch as unknown as typeof fetch });

  function callsTo(pathSuffix: string): Array<[string, RequestInit]> {
    return mockFetch.mock.calls.filter(([url]) => String(url).endsWith(pathSuffix)) as Array<
      [string, RequestInit]
    >;
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'actorium-channel-test-'));
    mockFetch = jest.fn().mockResolvedValue(makeResponse(200));
  });

  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns null (no-op) when there is no usable pairing', () => {
    const handle = startChannel(CONFIG, { homeDir: tempHome, ...fetchOptions() });
    expect(handle).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('subscribes to the participant SSE event stream with the pairing auth', async () => {
    writePairing(tempHome);

    const handle = startChannel(CONFIG, { homeDir: tempHome, ...fetchOptions() });
    expect(handle).not.toBeNull();

    // The subscription resolves a fresh token before opening the stream, so the
    // fetch lands a few microtasks after startChannel returns rather than inline.
    await new Promise((resolve) => setImmediate(resolve));

    const eventsCalls = callsTo('/events');
    expect(eventsCalls).toHaveLength(1);
    const [url, init] = eventsCalls[0];
    expect(url).toBe(`${BFF}/bff/hermes-agent/api/v1/participants/participant-123/events`);
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      Accept: 'text/event-stream',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    });

    handle!.stop();
  });

  it('heartbeats presence every 30s, authenticated as the participant', async () => {
    jest.useFakeTimers();
    writePairing(tempHome);

    const handle = startChannel(CONFIG, { homeDir: tempHome, ...fetchOptions() });
    expect(handle).not.toBeNull();

    // only the SSE subscription fires immediately; presence waits for the interval
    expect(callsTo('/presence')).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(callsTo('/presence')).toHaveLength(1);
    const [url, init] = callsTo('/presence')[0];
    expect(url).toBe(`${BFF}/bff/hermes-agent/api/v1/participants/participant-123/presence`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${ACCESS_TOKEN}` });

    await jest.advanceTimersByTimeAsync(30_000);
    expect(callsTo('/presence')).toHaveLength(2);

    handle!.stop();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(callsTo('/presence')).toHaveLength(2); // stopped — no further heartbeats
  });

  it('stop() is idempotent and does not throw', async () => {
    jest.useFakeTimers();
    writePairing(tempHome);

    const handle = startChannel(CONFIG, { homeDir: tempHome, ...fetchOptions() })!;
    handle.stop();
    expect(() => handle.stop()).not.toThrow();
  });
});
