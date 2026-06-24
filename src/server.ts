import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Config } from './config.js';
import { BffClient } from './bffClient.js';
import { registerTools } from './tools.js';

export function createServer(config: Config): McpServer {
  const server = new McpServer({
    name: 'workflow-mcp',
    version: '0.1.0',
  });

  const bffClient = new BffClient(config.bffUrl, config.sessionCookie);
  registerTools(server, bffClient);

  return server;
}
