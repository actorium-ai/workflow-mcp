import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Config } from './config.js';
import { BffClient } from './bffClient.js';

export function createServer(config: Config): McpServer {
  const server = new McpServer({
    name: 'workflow-mcp',
    version: '0.1.0',
  });

  const bffClient = new BffClient(config.bffUrl, config.sessionCookie);

  // T29: auth wired — BffClient attaches Cookie: session_id on every request.
  // T30: real tool implementations replace these stubs.
  registerPlaceholderTools(server, bffClient);

  return server;
}

// Placeholder until T30 implements real tools.
// These stubs confirm the scaffold compiles and the server initialises.
function registerPlaceholderTools(server: McpServer, _bffClient: BffClient): void {
  server.tool(
    'get_feature',
    'Get a workflow feature by name (implementation in T30)',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: 'get_feature is not yet implemented (T30)' }],
    }),
  );

  server.tool(
    'create_tasks',
    'Create tasks for a workflow feature (implementation in T30)',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: 'create_tasks is not yet implemented (T30)' }],
    }),
  );
}
