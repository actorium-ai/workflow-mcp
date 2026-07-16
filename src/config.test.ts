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

  it('returns undefined readToken when WORKFLOW_READ_TOKEN is not set', () => {
    delete process.env.WORKFLOW_READ_TOKEN;
    const config = loadConfig();
    expect(config.readToken).toBeUndefined();
  });

  it('returns readToken from env when WORKFLOW_READ_TOKEN is set', () => {
    process.env.WORKFLOW_READ_TOKEN = 'read-tok-abc';
    const config = loadConfig();
    expect(config.readToken).toBe('read-tok-abc');
  });

  it('returns undefined writeToken when WORKFLOW_WRITE_TOKEN is not set', () => {
    delete process.env.WORKFLOW_WRITE_TOKEN;
    const config = loadConfig();
    expect(config.writeToken).toBeUndefined();
  });

  it('returns writeToken from env when WORKFLOW_WRITE_TOKEN is set', () => {
    process.env.WORKFLOW_WRITE_TOKEN = 'write-tok-xyz';
    const config = loadConfig();
    expect(config.writeToken).toBe('write-tok-xyz');
  });

  it('returns all three token types independently', () => {
    process.env.WORKFLOW_SESSION_COOKIE = 'legacy-cookie';
    process.env.WORKFLOW_READ_TOKEN = 'read-tok';
    process.env.WORKFLOW_WRITE_TOKEN = 'write-tok';
    const config = loadConfig();
    expect(config.sessionCookie).toBe('legacy-cookie');
    expect(config.readToken).toBe('read-tok');
    expect(config.writeToken).toBe('write-tok');
  });
});
