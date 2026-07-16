export interface Config {
  bffUrl: string;
  /** @deprecated Use readToken and writeToken for scoped access. */
  sessionCookie: string | undefined;
  /** Token scoped to GET operations. Falls back to sessionCookie when absent. */
  readToken: string | undefined;
  /** Token scoped to POST/PUT/DELETE operations. Falls back to sessionCookie when absent. */
  writeToken: string | undefined;
}

const DEFAULT_BFF_URL = 'http://localhost:8090';

export function loadConfig(): Config {
  const bffUrl = process.env.WORKFLOW_BFF_URL ?? DEFAULT_BFF_URL;
  const sessionCookie = process.env.WORKFLOW_SESSION_COOKIE;
  const readToken = process.env.WORKFLOW_READ_TOKEN;
  const writeToken = process.env.WORKFLOW_WRITE_TOKEN;
  return { bffUrl, sessionCookie, readToken, writeToken };
}
