import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Config } from './config.js';
import { BffClient } from './bffClient.js';
import { registerTools } from './tools.js';

export function createServer(config: Config): McpServer {
  const server = new McpServer({
    name: 'actorium-mcp',
    version: '0.1.0',
  });

  const bffClient = new BffClient(config.bffUrl, config.bearerToken);
  registerTools(server, bffClient, config.defaultWorkspaceId, config.defaultOrgId);

  return server;
}
