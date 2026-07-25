#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import packageJson from '../package.json';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }

  const config = loadConfig();
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`actorium-mcp: fatal error: ${err}\n`);
  process.exit(1);
});
