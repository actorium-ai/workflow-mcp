import { createServer } from './server';
import { Config } from './config';

describe('createServer', () => {
  const config: Config = {
    bffUrl: 'http://localhost:3000',
    sessionCookie: undefined,
  };

  it('returns an McpServer instance', () => {
    const server = createServer(config);
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });

  it('creates a new server for each call', () => {
    const a = createServer(config);
    const b = createServer(config);
    expect(a).not.toBe(b);
  });
});
