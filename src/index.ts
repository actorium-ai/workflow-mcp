#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import packageJson from '../package.json';
import { loadConfig } from './config.js';
import { runPair } from './pair.js';
import { createServer } from './server.js';

/**
 * CLI entry point. Dispatches on the first argument after the script path:
 *
 *   --version | -v        print the installed version and exit
 *   pair [--handle <h>]   run the local-agent device-flow pairing flow
 *   (anything else)       start the stdio MCP server
 *
 * `argv` is injected for tests; it defaults to the real `process.argv`.
 */
export async function runCli(argv: string[] = process.argv): Promise<void> {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }

  const args = argv.slice(2);
  if (args[0] === 'pair') {
    await runPair(args.slice(1));
    return;
  }

  const config = loadConfig();
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only execute when this file is the process entry point (not when imported by
// a test, which also needs to exercise runCli's dispatch).
if (require.main === module) {
  runCli().catch((err) => {
    process.stderr.write(`actorium-mcp: fatal error: ${err}\n`);
    process.exit(1);
  });
}
