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

describe('BffClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('Bearer token (shared credential file)', () => {
    it('attaches Authorization: Bearer header when bearerToken is set', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { ok: true }));
      const client = new BffClient('http://bff.example.com', 'jwt-abc');
      await client.get('/api/test');

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Authorization']).toBe('Bearer jwt-abc');
    });

    it('does not attach Authorization header when bearerToken is undefined', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { ok: true }));
      const client = new BffClient('http://bff.example.com', undefined);
      await client.get('/api/test');

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Authorization']).toBeUndefined();
    });

    it('strips trailing slash from bffUrl before appending path', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
      const client = new BffClient('http://bff.example.com/', 'jwt-abc');
      await client.get('/api/foo');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('http://bff.example.com/api/foo');
    });

    it('401 error message points at reconnecting via the extension', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(401));
      const client = new BffClient('http://bff.example.com', 'expired-jwt');

      await expect(client.get('/api/test')).rejects.toThrow(/Actorium: Connect/);
    });
  });

  describe('401 handling', () => {
    it('throws BffAuthError with re-auth guidance on 401', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(401));
      const client = new BffClient('http://bff.example.com', 'expired');

      await expect(client.get('/api/test')).rejects.toThrow(BffAuthError);
    });
  });

  describe('non-401 error handling', () => {
    it('throws a BffRequestError with status info on 500', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(500, 'internal error'));
      const client = new BffClient('http://bff.example.com', 'tok');

      let err: unknown;
      try {
        await client.get('/api/test');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BffRequestError);
      expect((err as BffRequestError).message).toContain('500');
    });

    it('throws on 404', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(404));
      const client = new BffClient('http://bff.example.com', 'tok');

      await expect(client.get('/api/test')).rejects.toThrow('404');
    });

    it('BffRequestError carries the status code', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(422, [{ name: 'T1', reason: 'duplicate' }]));
      const client = new BffClient('http://bff.example.com', 'tok');

      let err: BffRequestError | undefined;
      try {
        await client.get('/api/test');
      } catch (e) {
        if (e instanceof BffRequestError) err = e;
      }
      expect(err).toBeInstanceOf(BffRequestError);
      expect(err?.status).toBe(422);
    });

    it('BffRequestError carries the parsed JSON body', async () => {
      const failureBody = [{ name: 'T1', reason: 'already exists' }];
      mockFetch.mockResolvedValueOnce(makeResponse(422, failureBody));
      const client = new BffClient('http://bff.example.com', 'tok');

      let err: BffRequestError | undefined;
      try {
        await client.get('/api/test');
      } catch (e) {
        if (e instanceof BffRequestError) err = e;
      }
      expect(err?.body).toEqual(failureBody);
    });
  });

  describe('get', () => {
    it('sends a GET request to the given path', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { id: '1' }));
      const client = new BffClient('http://bff.example.com', 'tok');
      const result = await client.get<{ id: string }>('/api/features');

      const [, init] = mockFetch.mock.calls[0];
      expect(init.method).toBe('GET');
      expect(result).toEqual({ id: '1' });
    });
  });
});
