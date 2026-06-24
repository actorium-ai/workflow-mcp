export class BffAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BffAuthError';
  }
}

export class BffClient {
  private readonly bffUrl: string;
  private readonly sessionCookie: string | undefined;

  constructor(bffUrl: string, sessionCookie: string | undefined) {
    this.bffUrl = bffUrl.replace(/\/$/, '');
    this.sessionCookie = sessionCookie;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.bffUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };

    if (this.sessionCookie) {
      headers['Cookie'] = `session_id=${this.sessionCookie}`;
    }

    const response = await fetch(url, { ...init, headers });

    if (response.status === 401) {
      throw new BffAuthError(
        'Authentication failed (401). Your session cookie has expired or is invalid. ' +
          'Please log in again at the BFF URL and update the WORKFLOW_SESSION_COOKIE ' +
          'environment variable in your mcpServers configuration with the new session_id cookie value.',
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`BFF request failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`);
    }

    return response.json() as Promise<T>;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}
