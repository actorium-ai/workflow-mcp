import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Config } from './config.js';
import { BffClient } from './bffClient.js';
import { registerReviewTools } from './reviewTools.js';
import { registerTools } from './tools.js';
import { registerVcsTools } from './vcsTools.js';

/**
 * `getConfig` is re-invoked per tool call (see BffClient's class doc) rather
 * than resolved once here, so a renewed token or an account/workspace switch
 * takes effect without restarting this process.
 */
export function createServer(getConfig: () => Config): McpServer {
  const server = new McpServer({
    name: 'actorium-mcp',
    version: '0.1.0',
  });

  const bffClient = new BffClient(getConfig);
  registerTools(server, bffClient, getConfig);
  registerReviewTools(server, getConfig);
  registerVcsTools(server, bffClient, getConfig);

  return server;
}
