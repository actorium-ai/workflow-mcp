import { Config } from './config';
import {
  consumeSseStream,
  expiryFromAccessToken,
  parseSseData,
  participantIdFromAccessToken,
  resolveParticipant,
  startChannel,
} from './channel';

const BFF = 'http://bff.example.com';

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

function configWithToken(accessToken?: string): Config {
  return { bffUrl: BFF, bearerToken: accessToken };
}

const LOGGED_IN = (): Config => configWithToken(ACCESS_TOKEN);
const LOGGED_OUT = (): Config => configWithToken(undefined);

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
  it('returns null when there is no bearer token', () => {
    expect(resolveParticipant(LOGGED_OUT())).toBeNull();
  });

  it('returns the participant id and access token when logged in', () => {
    expect(resolveParticipant(LOGGED_IN())).toEqual({
      participantId: 'participant-123',
      accessToken: ACCESS_TOKEN,
    });
  });

  it('returns null when the access token lacks agent_participant_id', () => {
    expect(resolveParticipant(configWithToken(makeAccessToken({ sub: 'user-1' })))).toBeNull();
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
  let mockFetch: jest.Mock;

  const fetchOptions = () => ({ fetch: mockFetch as unknown as typeof fetch });

  function callsTo(pathSuffix: string): Array<[string, RequestInit]> {
    return mockFetch.mock.calls.filter(([url]) => String(url).endsWith(pathSuffix)) as Array<
      [string, RequestInit]
    >;
  }

  beforeEach(() => {
    mockFetch = jest.fn().mockResolvedValue(makeResponse(200));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns null (no-op) when there is no usable login', () => {
    const handle = startChannel(LOGGED_OUT, fetchOptions());
    expect(handle).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('subscribes to the participant SSE event stream with the login auth', async () => {
    const handle = startChannel(LOGGED_IN, fetchOptions());
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

    const handle = startChannel(LOGGED_IN, fetchOptions());
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

  it('picks up a rotated token on the next heartbeat, without restarting', async () => {
    jest.useFakeTimers();
    const ROTATED_TOKEN = makeAccessToken({ agent_participant_id: 'participant-123' });
    let current = ACCESS_TOKEN;

    const handle = startChannel(() => configWithToken(current), fetchOptions());
    expect(handle).not.toBeNull();

    current = ROTATED_TOKEN;
    await jest.advanceTimersByTimeAsync(30_000);

    const [, init] = callsTo('/presence')[0];
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${ROTATED_TOKEN}` });

    handle!.stop();
  });

  it('stop() is idempotent and does not throw', async () => {
    jest.useFakeTimers();

    const handle = startChannel(LOGGED_IN, fetchOptions())!;
    handle.stop();
    expect(() => handle.stop()).not.toThrow();
  });
});
