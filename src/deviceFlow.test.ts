import {
  DeviceFlowError,
  exchange,
  pollAndExchange,
  refresh,
  start,
} from './deviceFlow';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const BFF = 'http://bff.example.com';

const DEVICE_RESPONSE = {
  device_code: 'device-code-1',
  user_code: 'UC-1234',
  verification_uri: 'https://bff.example.com/device-authorize',
};

const TOKENS = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  token_type: 'Bearer',
  expires_in: 3600,
};

function makeResponse(status: number, body: unknown = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('deviceFlow', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('start', () => {
    it('POSTs the client_id + handle to /oauth/device and returns the codes', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, DEVICE_RESPONSE));

      const result = await start(BFF, { client_id: 'actorium-local-agent', handle: 'dev-agent' });

      expect(result).toEqual(DEVICE_RESPONSE);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BFF}/oauth/device`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        client_id: 'actorium-local-agent',
        handle: 'dev-agent',
      });
    });

    it('strips a trailing slash from bffUrl', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, DEVICE_RESPONSE));

      await start(`${BFF}/`, { client_id: 'actorium-local-agent', handle: 'h' });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BFF}/oauth/device`);
    });
  });

  describe('exchange', () => {
    it('POSTs the device-code grant to /oauth/device/token', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, TOKENS));

      const result = await exchange(BFF, 'device-code-1', 'actorium-local-agent');

      expect(result).toEqual(TOKENS);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BFF}/oauth/device/token`);
      expect(JSON.parse(init.body)).toEqual({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'device-code-1',
        client_id: 'actorium-local-agent',
      });
    });
  });

  describe('refresh', () => {
    it('POSTs grant_type=refresh_token with the refresh token', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, TOKENS));

      const result = await refresh(BFF, 'refresh-1');

      expect(result).toEqual(TOKENS);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BFF}/oauth/device/token`);
      expect(JSON.parse(init.body)).toEqual({
        grant_type: 'refresh_token',
        refresh_token: 'refresh-1',
      });
    });
  });

  describe('pollAndExchange', () => {
    it('retries on authorization_pending, then returns the tokens on approval', async () => {
      mockFetch
        .mockResolvedValueOnce(makeResponse(400, { error: 'authorization_pending' }))
        .mockResolvedValueOnce(makeResponse(200, TOKENS));

      const result = await pollAndExchange(BFF, 'device-code-1', 'actorium-local-agent', {
        intervalMs: 1,
      });

      expect(result).toEqual(TOKENS);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries on slow_down (backing off), then succeeds', async () => {
      jest.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(makeResponse(400, { error: 'slow_down' }))
          .mockResolvedValueOnce(makeResponse(200, TOKENS));

        const resultPromise = pollAndExchange(BFF, 'device-code-1', 'actorium-local-agent', {
          intervalMs: 1,
        });

        await jest.advanceTimersByTimeAsync(10_000);

        await expect(resultPromise).resolves.toEqual(TOKENS);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('throws a DeviceFlowError on access_denied without further retries', async () => {
      mockFetch.mockResolvedValue(makeResponse(400, { error: 'access_denied' }));

      await expect(
        pollAndExchange(BFF, 'device-code-1', 'actorium-local-agent', { intervalMs: 1 }),
      ).rejects.toMatchObject({ name: 'DeviceFlowError', code: 'access_denied' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws expired_token when the grant is never approved before the deadline', async () => {
      mockFetch.mockResolvedValue(makeResponse(400, { error: 'authorization_pending' }));

      await expect(
        pollAndExchange(BFF, 'device-code-1', 'actorium-local-agent', { deadlineMs: 0 }),
      ).rejects.toMatchObject({ name: 'DeviceFlowError', code: 'expired_token' });
    });
  });

  describe('error body parsing', () => {
    it('falls back to the HTTP status as the code when the body is not an OAuth error object', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(500, 'internal server error'));

      await expect(exchange(BFF, 'device-code-1', 'actorium-local-agent')).rejects.toMatchObject({
        name: 'DeviceFlowError',
        code: '500',
      });
    });
  });
});
