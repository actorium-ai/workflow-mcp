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

/** Thrown when a mutation is attempted but no write token is configured. */
export class BffMissingWriteTokenError extends Error {
  constructor() {
    super(
      'No write token configured for mutation request. ' +
        'Set WORKFLOW_WRITE_TOKEN (for scoped access) or WORKFLOW_SESSION_COOKIE (legacy) ' +
        'in your mcpServers environment configuration.',
    );
    this.name = 'BffMissingWriteTokenError';
  }
}

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class BffClient {
  private readonly bffUrl: string;
  /** @deprecated Prefer readToken/writeToken. Used as fallback when scoped tokens are absent. */
  private readonly sessionCookie: string | undefined;
  private readonly readToken: string | undefined;
  private readonly writeToken: string | undefined;

  constructor(
    bffUrl: string,
    sessionCookie: string | undefined,
    readToken?: string,
    writeToken?: string,
  ) {
    this.bffUrl = bffUrl.replace(/\/$/, '');
    this.sessionCookie = sessionCookie;
    this.readToken = readToken;
    this.writeToken = writeToken;
  }

  private resolveToken(method: string): string | undefined {
    const upperMethod = method.toUpperCase();
    if (MUTATION_METHODS.has(upperMethod)) {
      const token = this.writeToken ?? this.sessionCookie;
      if (token === undefined) {
        throw new BffMissingWriteTokenError();
      }
      return token;
    }
    return this.readToken ?? this.sessionCookie;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = (typeof init.method === 'string' ? init.method : 'GET').toUpperCase();
    const token = this.resolveToken(method);

    const url = `${this.bffUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };

    if (token) {
      headers['Cookie'] = `session_id=${token}`;
    }

    const response = await fetch(url, { ...init, headers });

    if (response.status === 401) {
      throw new BffAuthError(
        'Authentication failed (401). Your session token has expired or is invalid. ' +
          'Please log in again at the BFF URL and update WORKFLOW_READ_TOKEN and ' +
          'WORKFLOW_WRITE_TOKEN (or the legacy WORKFLOW_SESSION_COOKIE) ' +
          'in your mcpServers configuration with fresh token values.',
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

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}
