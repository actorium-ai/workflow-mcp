import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Config } from './config.js';

export function createServer(config: Config): McpServer {
  const server = new McpServer({
    name: 'workflow-mcp',
    version: '0.1.0',
  });

  // T29: auth + T30: tools are registered in subsequent tasks.
  // The server is scaffolded here and tools are added incrementally.
  registerPlaceholderTools(server, config);

  return server;
}

// Placeholder until T29/T30 implement real tools.
// These stubs confirm the scaffold compiles and the server initialises.
function registerPlaceholderTools(server: McpServer, _config: Config): void {
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
