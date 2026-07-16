import { BffClient, BffAuthError, BffRequestError, BffMissingWriteTokenError } from './bffClient';

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

  describe('Cookie header (legacy sessionCookie)', () => {
    it('attaches Cookie: session_id header when sessionCookie is set', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { ok: true }));
      const client = new BffClient('http://bff.example.com', 'abc123');
      await client.get('/api/test');

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Cookie']).toBe('session_id=abc123');
    });

    it('does not attach Cookie header when sessionCookie is undefined', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { ok: true }));
      const client = new BffClient('http://bff.example.com', undefined);
      await client.get('/api/test');

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Cookie']).toBeUndefined();
    });

    it('strips trailing slash from bffUrl before appending path', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
      const client = new BffClient('http://bff.example.com/', 'tok');
      await client.get('/api/foo');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('http://bff.example.com/api/foo');
    });

    it('uses sessionCookie for POST when writeToken is not set (backward compat)', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { created: true }));
      const client = new BffClient('http://bff.example.com', 'legacy-cookie');
      await client.post('/api/tasks', { name: 'T1' });

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Cookie']).toBe('session_id=legacy-cookie');
    });
  });

  describe('Scoped token selection', () => {
    it('uses readToken for GET requests when set', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
      const client = new BffClient('http://bff.example.com', undefined, 'read-tok', 'write-tok');
      await client.get('/api/features');

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Cookie']).toBe('session_id=read-tok');
    });

    it('uses writeToken for POST requests when set', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
      const client = new BffClient('http://bff.example.com', undefined, 'read-tok', 'write-tok');
      await client.post('/api/tasks', {});

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Cookie']).toBe('session_id=write-tok');
    });

    it('readToken falls back to sessionCookie for GET when readToken is absent', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
      const client = new BffClient('http://bff.example.com', 'legacy', undefined, 'write-tok');
      await client.get('/api/features');

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Cookie']).toBe('session_id=legacy');
    });

    it('writeToken falls back to sessionCookie for POST when writeToken is absent', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
      const client = new BffClient('http://bff.example.com', 'legacy', 'read-tok', undefined);
      await client.post('/api/tasks', {});

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Cookie']).toBe('session_id=legacy');
    });

    it('readToken takes precedence over sessionCookie for GET', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
      const client = new BffClient('http://bff.example.com', 'legacy', 'read-tok', 'write-tok');
      await client.get('/api/features');

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Cookie']).toBe('session_id=read-tok');
    });

    it('writeToken takes precedence over sessionCookie for POST', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
      const client = new BffClient('http://bff.example.com', 'legacy', 'read-tok', 'write-tok');
      await client.post('/api/tasks', {});

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Cookie']).toBe('session_id=write-tok');
    });
  });

  describe('test_readOnlyToken_cannotMutate', () => {
    it('throws BffMissingWriteTokenError on POST when only readToken is set', async () => {
      const client = new BffClient('http://bff.example.com', undefined, 'read-tok', undefined);
      await expect(client.post('/api/tasks', {})).rejects.toThrow(BffMissingWriteTokenError);
    });

    it('throws BffMissingWriteTokenError on POST when no tokens at all', async () => {
      const client = new BffClient('http://bff.example.com', undefined);
      await expect(client.post('/api/tasks', {})).rejects.toThrow(BffMissingWriteTokenError);
    });

    it('BffMissingWriteTokenError message mentions WORKFLOW_WRITE_TOKEN', async () => {
      const client = new BffClient('http://bff.example.com', undefined, 'read-tok', undefined);
      await expect(client.post('/api/tasks', {})).rejects.toThrow('WORKFLOW_WRITE_TOKEN');
    });

    it('does NOT throw for GET even when writeToken is absent', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
      const client = new BffClient('http://bff.example.com', undefined, 'read-tok', undefined);
      await expect(client.get('/api/features')).resolves.toBeDefined();
    });
  });

  describe('test_writeToken_canMutate', () => {
    it('POST with writeToken succeeds and uses the write token', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { created: true }));
      const client = new BffClient('http://bff.example.com', undefined, 'read-tok', 'write-tok');
      const result = await client.post<{ created: boolean }>('/api/tasks', { name: 'T1' });

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['Cookie']).toBe('session_id=write-tok');
      expect(result).toEqual({ created: true });
    });
  });

  describe('401 handling', () => {
    it('throws BffAuthError with re-auth guidance on 401', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(401));
      const client = new BffClient('http://bff.example.com', 'expired');

      await expect(client.get('/api/test')).rejects.toThrow(BffAuthError);
    });

    it('401 error message mentions WORKFLOW_READ_TOKEN and WORKFLOW_WRITE_TOKEN', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(401));
      const client = new BffClient('http://bff.example.com', 'expired');

      await expect(client.get('/api/test')).rejects.toThrow('WORKFLOW_READ_TOKEN');
    });

    it('401 error message mentions WORKFLOW_SESSION_COOKIE (legacy)', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(401));
      const client = new BffClient('http://bff.example.com', 'expired');

      await expect(client.get('/api/test')).rejects.toThrow('WORKFLOW_SESSION_COOKIE');
    });

    it('401 error message mentions re-login guidance', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(401));
      const client = new BffClient('http://bff.example.com', 'expired');

      await expect(client.get('/api/test')).rejects.toThrow(/log in again/i);
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

  describe('post', () => {
    it('sends a POST request with JSON body', async () => {
      mockFetch.mockResolvedValueOnce(makeResponse(200, { created: true }));
      const client = new BffClient('http://bff.example.com', 'tok');
      const result = await client.post<{ created: boolean }>('/api/tasks', { name: 'T1' });

      const [, init] = mockFetch.mock.calls[0];
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ name: 'T1' }));
      expect(result).toEqual({ created: true });
    });
  });
});
