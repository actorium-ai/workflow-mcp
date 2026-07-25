export class BffAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BffAuthError';
  }
}

export class BffRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'BffRequestError';
  }
}

export class BffClient {
  private readonly bffUrl: string;
  /** Bearer JWT — from WORKFLOW_TOKEN or the shared credential file (see
   * authFile.ts). There's no read/write split to enforce — every tool this
   * server exposes is a GET. */
  private readonly bearerToken: string | undefined;

  constructor(bffUrl: string, bearerToken?: string) {
    this.bffUrl = bffUrl.replace(/\/$/, '');
    this.bearerToken = bearerToken;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.bffUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };

    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    }

    const response = await fetch(url, { ...init, headers });

    if (response.status === 401) {
      throw new BffAuthError(
        'Authentication failed (401). Your Actorium session has expired. ' +
          'Run "Actorium: Connect" in VS Code to reconnect, then retry.',
      );
    }

    if (!response.ok) {
      let body: unknown;
      const text = await response.text().catch(() => '');
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text || undefined;
      }
      throw new BffRequestError(
        `BFF request failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`,
        response.status,
        body,
      );
    }

    return response.json() as Promise<T>;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }
}
