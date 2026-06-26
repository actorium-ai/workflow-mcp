import { loadConfig } from './config';

describe('loadConfig', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it('uses default BFF URL when WORKFLOW_BFF_URL is not set', () => {
    delete process.env.WORKFLOW_BFF_URL;
    const config = loadConfig();
    expect(config.bffUrl).toBe('http://localhost:8090');
  });

  it('uses WORKFLOW_BFF_URL from env when set', () => {
    process.env.WORKFLOW_BFF_URL = 'https://bff.example.com';
    const config = loadConfig();
    expect(config.bffUrl).toBe('https://bff.example.com');
  });

  it('returns undefined sessionCookie when WORKFLOW_SESSION_COOKIE is not set', () => {
    delete process.env.WORKFLOW_SESSION_COOKIE;
    const config = loadConfig();
    expect(config.sessionCookie).toBeUndefined();
  });

  it('returns sessionCookie from env when set', () => {
    process.env.WORKFLOW_SESSION_COOKIE = 'abc123';
    const config = loadConfig();
    expect(config.sessionCookie).toBe('abc123');
  });
});
