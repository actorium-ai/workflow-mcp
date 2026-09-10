import { BffClient, BffAuthError, BffRequestError } from './bffClient';

const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function client(bffUrl: string, bearerToken?: string, accountLabel?: string): BffClient {
  return new BffClient(() => ({ bffUrl, bearerToken, accountLabel }));
}

describe('BffClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('Bearer token (shared credential file)', () => {
    it('attaches Authorization: Bearer header when bearerToken is set', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { ok: true }));
      await client('http://bff.example.com', 'jwt-abc').get('/api/test');

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Authorization']).toBe('Bearer jwt-abc');
    });

    it('does not attach Authorization header when bearerToken is undefined', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { ok: true }));
      await client('http://bff.example.com', undefined).get('/api/test');

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Authorization']).toBeUndefined();
    });

    it('strips trailing slash from bffUrl before appending path', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
      await client('http://bff.example.com/', 'jwt-abc').get('/api/foo');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('http://bff.example.com/api/foo');
    });

    it('401 error message points at reconnecting via the extension', async () => {
      mockFetch.mockResolvedValue(makeResponse(401));

      await expect(client('http://bff.example.com', 'expired-jwt').get('/api/test')).rejects.toThrow(
        /Actorium: Connect/,
      );
    });
  });

  describe('401 handling', () => {
    it('throws BffAuthError with re-auth guidance on 401', async () => {
      mockFetch.mockResolvedValue(makeResponse(401));

      await expect(client('http://bff.example.com', 'expired').get('/api/test')).rejects.toThrow(
        BffAuthError,
      );
    });

    it('re-reads config fresh per request, so a renewed token is used without restarting', async () => {
      // Simulates the extension rewriting the credential file between two
      // tool calls — getConfig() must be re-invoked, not captured once at
      // construction (see BffClient's class doc).
      let token = 'first-token';
      const bffClient = new BffClient(() => ({ bffUrl: 'http://bff.example.com', bearerToken: token }));

      mockFetch.mockResolvedValueOnce(makeResponse(200, { ok: true }));
      await bffClient.get('/api/test');
      expect(mockFetch.mock.calls[0][1].headers['Authorization']).toBe('Bearer first-token');

      token = 'renewed-token';
      mockFetch.mockResolvedValueOnce(makeResponse(200, { ok: true }));
      await bffClient.get('/api/test');
      expect(mockFetch.mock.calls[1][1].headers['Authorization']).toBe('Bearer renewed-token');
    });

    it('on a 401, re-reads config once and retries with a rotated token before failing', async () => {
      let token = 'stale-token';
      const bffClient = new BffClient(() => ({ bffUrl: 'http://bff.example.com', bearerToken: token }));

      // Token rotates the instant the first 401 comes back — simulates the
      // extension's proactive renewal landing mid-request.
      mockFetch.mockImplementationOnce(async () => {
        token = 'fresh-token';
        return makeResponse(401);
      });
      mockFetch.mockResolvedValueOnce(makeResponse(200, { ok: true }));

      const result = await bffClient.get('/api/test');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1][1].headers['Authorization']).toBe('Bearer fresh-token');
      expect(result).toEqual({ ok: true });
    });

    it('does not retry when the re-read token is unchanged, and names the account in the error', async () => {
      mockFetch.mockResolvedValue(makeResponse(401));

      await expect(
        client('http://bff.example.com', 'stale-token', 'dev@example.com').get('/api/test'),
      ).rejects.toThrow(/dev@example\.com/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-401 error handling', () => {
    it('throws a BffRequestError with status info on 500', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(500, 'internal error'));

      let err: unknown;
      try {
        await client('http://bff.example.com', 'tok').get('/api/test');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BffRequestError);
      expect((err as BffRequestError).message).toContain('500');
    });

    it('throws on 404', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(404));

      await expect(client('http://bff.example.com', 'tok').get('/api/test')).rejects.toThrow('404');
    });

    it('BffRequestError carries the status code', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(422, [{ name: 'T1', reason: 'duplicate' }]));

      let err: BffRequestError | undefined;
      try {
        await client('http://bff.example.com', 'tok').get('/api/test');
      } catch (e) {
        if (e instanceof BffRequestError) err = e;
      }
      expect(err).toBeInstanceOf(BffRequestError);
      expect(err?.status).toBe(422);
    });

    it('BffRequestError carries the parsed JSON body', async () => {
      const failureBody = [{ name: 'T1', reason: 'already exists' }];
      mockFetch.mockResolvedValueOnce(makeResponse(422, failureBody));

      let err: BffRequestError | undefined;
      try {
        await client('http://bff.example.com', 'tok').get('/api/test');
      } catch (e) {
        if (e instanceof BffRequestError) err = e;
      }
      expect(err?.body).toEqual(failureBody);
    });
  });

  describe('get', () => {
    it('sends a GET request to the given path', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { id: '1' }));
      const result = await client('http://bff.example.com', 'tok').get<{ id: string }>('/api/features');

      const [, init] = mockFetch.mock.calls[0];
      expect(init.method).toBe('GET');
      expect(result).toEqual({ id: '1' });
    });
  });

  describe('post', () => {
    it('sends a POST request with a JSON-serialized body', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(201, { id: '1' }));
      const result = await client('http://bff.example.com', 'tok').post<{ id: string }>('/api/documents', {
        path: 'a.md',
      });

      const [, init] = mockFetch.mock.calls[0];
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ path: 'a.md' }));
      expect(result).toEqual({ id: '1' });
    });
  });

  describe('put', () => {
    it('sends a PUT request with a JSON-serialized body', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { ok: true }));
      const result = await client('http://bff.example.com', 'tok').put<{ ok: boolean }>(
        '/api/documents/content?path=a.md',
        { content: 'hi' },
      );

      const [, init] = mockFetch.mock.calls[0];
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ content: 'hi' }));
      expect(result).toEqual({ ok: true });
    });
  });
});
