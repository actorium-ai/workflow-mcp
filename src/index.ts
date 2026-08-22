#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import packageJson from '../package.json';
import { startChannel } from './channel.js';
import { loadConfig } from './config.js';
import { runPair, runPairings, runUnpair } from './pair.js';
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

  // Lists which backends this machine is paired to — the thing to compare
  // against the API_URL the MCP server is configured with.
  if (args[0] === 'pairings') {
    runPairings();
    return;
  }

  if (args[0] === 'unpair') {
    await runUnpair(args.slice(1));
    return;
  }

  const config = loadConfig();
  const server = createServer(config);

  // startChannel returns null when there is no usable pairing for this
  // backend. That is a legitimate state (an unpaired install), but it is also
  // exactly what a backend mismatch looks like — pairing files are keyed by
  // the backend url, so a pair against a DIFFERENT API_URL leaves nothing to
  // find here. Silence made that indistinguishable from working: no presence
  // heartbeat is ever sent and the review UI just says "paired but
  // unreachable". Warn on stderr (never stdout — that is the MCP transport).
  if (startChannel(config) === null) {
    process.stderr.write(
      `actorium-mcp: no local-agent pairing found for ${config.bffUrl} — ` +
        `not sending presence. Run: actorium-mcp pair --api-url ${config.bffUrl}\n`,
    );
  }
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
