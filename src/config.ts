export interface Config {
  bffUrl: string;
  sessionCookie: string | undefined;
}

const DEFAULT_BFF_URL = 'http://localhost:3000';

export function loadConfig(): Config {
  const bffUrl = process.env.WORKFLOW_BFF_URL ?? DEFAULT_BFF_URL;
  const sessionCookie = process.env.WORKFLOW_SESSION_COOKIE;
  return { bffUrl, sessionCookie };
}
