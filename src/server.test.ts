import { createServer } from './server';
import { Config } from './config';

describe('createServer', () => {
  const config: Config = {
    bffUrl: 'http://localhost:8090',
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

  it('registers the paired-agent review tools', () => {
    const server = createServer(config);
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(['review_get_turn', 'review_submit_reply']),
    );
  });
});
