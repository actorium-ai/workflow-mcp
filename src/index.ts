#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import packageJson from '../package.json';
import { startChannel } from './channel.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

/**
 * CLI entry point. Dispatches on the first argument after the script path:
 *
 *   --version | -v    print the installed version and exit
 *   (anything else)   start the stdio MCP server
 *
 * `argv` is injected for tests; it defaults to the real `process.argv`.
 */
export async function runCli(argv: string[] = process.argv): Promise<void> {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }

  // bffUrl is process-lifetime-stable (sourced from the immutable API_URL env
  // var), so this loadConfig() call is fine for the startup message — only
  // the MCP server's own tool calls need a fresh read per invocation (see
  // BffClient's class doc); the channel re-reads it per heartbeat/reconnect
  // itself (see channel.ts).
  const config = loadConfig();
  const server = createServer(() => loadConfig());

  // startChannel returns null when there is no usable login for this
  // process — no WORKFLOW_TOKEN/credential file, or a token whose JWT
  // carries no agent_participant_id claim. That's a legitimate state (not
  // logged in yet), but silence made it indistinguishable from working: no
  // presence heartbeat is ever sent and review tools would just fail with
  // `not_logged_in`. Warn on stderr (never stdout — that is the MCP
  // transport).
  if (startChannel(() => loadConfig()) === null) {
    process.stderr.write(
      `actorium-mcp: not logged in for ${config.bffUrl} — not sending presence. ` +
        'Log in via the Actorium VS Code extension, or set WORKFLOW_TOKEN.\n',
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
