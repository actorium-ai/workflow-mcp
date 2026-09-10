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

/** The slice of Config a request actually needs, resolved fresh per request —
 * see BffClient's class doc for why this can't be frozen at construction. */
export interface BffClientConfig {
  bffUrl: string;
  bearerToken?: string;
  /** Display label (email/display name) for the account this token belongs
   * to — surfaced in the 401 error message so a stale-token failure names
   * which account/backend it tried, instead of a bare "session expired". */
  accountLabel?: string;
}

/**
 * `getConfig` is called fresh on every request rather than the bffUrl/token
 * being captured once at construction. The extension's AuthManager renews
 * tokens and rewrites the shared credential file on its own timer, on a
 * completely different lifecycle than this (long-lived, one-per-CLI-session)
 * process — freezing the token at startup meant a renewed token was never
 * picked up, and a 401 retry hit the exact same stale token and failed again.
 * Re-reading the (small, local) credential file per call is negligible next
 * to the network request that follows it — mirrors resolveParticipant's
 * per-call resolution of the same credential for the review channel/tools
 * (channel.ts).
 */
export class BffClient {
  constructor(private readonly getConfig: () => BffClientConfig) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const config = this.getConfig();
    const url = `${config.bffUrl.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };

    if (config.bearerToken) {
      headers['Authorization'] = `Bearer ${config.bearerToken}`;
    }

    let response = await fetch(url, { ...init, headers });
    let fresh = config;

    if (response.status === 401) {
      // The extension's proactive renewal runs on its own timer, independent
      // of tool-call timing — the token may have rotated between when this
      // handler started and when the request actually went out. Re-read once
      // and retry before giving up.
      fresh = this.getConfig();
      if (fresh.bearerToken && fresh.bearerToken !== config.bearerToken) {
        const retryHeaders = { ...headers };
        retryHeaders['Authorization'] = `Bearer ${fresh.bearerToken}`;
        response = await fetch(url, { ...init, headers: retryHeaders });
      }
    }

    if (response.status === 401) {
      const who = fresh.accountLabel ? ` for ${fresh.accountLabel}` : '';
      throw new BffAuthError(
        `Authentication failed (401)${who} against ${fresh.bffUrl}. Your Actorium session` +
          `${who ? ' for this account' : ''} has expired, or this MCP server is bound to a ` +
          'different account than the one you\'re signed in as. Run "Actorium: Switch Account" ' +
          'in VS Code and pick the right account, or "Actorium: Connect" to sign in again, then retry.',
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
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }
}
