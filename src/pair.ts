import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

import { resolveFreshParticipant } from './channel.js';
import { loadConfig } from './config.js';
import * as deviceFlow from './deviceFlow.js';
import type { TokenResponse } from './deviceFlow.js';
import { listPairings, pairingPath, PairingCredentials, savePairing } from './pairingStore.js';

/** Default pairing handle when `--handle` is omitted — the OS username. */
export function defaultHandle(): string {
  return os.userInfo().username;
}

/** Parses `--api-url <value>` or `--api-url=<value>` out of the pair args. */
export function parseApiUrl(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--api-url') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) return next;
      return undefined;
    }
    if (arg.startsWith('--api-url=')) {
      return arg.slice('--api-url='.length) || undefined;
    }
  }
  return undefined;
}

/** True when `--no-open` was passed (suppresses the browser launch). */
export function parseNoOpen(args: string[]): boolean {
  return args.includes('--no-open');
}

/**
 * Opens `url` in the user's default browser. Best-effort: pairing must still
 * work when there is no browser to open (a headless box, an SSH session, a
 * container), so every failure path is swallowed and the caller falls back to
 * the printed url. Returns whether a launch was actually attempted.
 *
 * Only absolute http(s) urls are opened — handing a bare path to `open` makes
 * it try to resolve a local file, which is both useless and confusing.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!/^https?:\/\//i.test(url)) return false;

  const [command, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? // the empty string is `start`'s window-title argument — without it a
          // quoted url is taken as the title and nothing opens
          ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    // A missing launcher (no xdg-open) surfaces as an async 'error' event, which
    // is an unhandled throw on the process unless it is consumed here.
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Parses `--handle <value>` or `--handle=<value>` out of the pair args. */
export function parseHandle(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--handle') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) return next;
      return undefined;
    }
    if (arg.startsWith('--handle=')) {
      return arg.slice('--handle='.length) || undefined;
    }
  }
  return undefined;
}

function accessTokenExpiry(creds: PairingCredentials): number {
  const expiresInMs = (creds.expiresIn ?? 3600) * 1000;
  return creds.updatedAt + expiresInMs;
}


function toCredentials(
  tokens: TokenResponse,
  clientId: string,
  handle: string,
  bffUrl: string,
): PairingCredentials {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    tokenType: tokens.token_type,
    clientId,
    handle,
    bffUrl,
    updatedAt: Date.now(),
  };
}

function printStatus(creds: PairingCredentials): void {
  const expiry = new Date(accessTokenExpiry(creds)).toISOString();
  process.stdout.write(`Paired as @${creds.handle ?? 'local-agent'}\n`);
  process.stdout.write(`  access token expires: ${expiry}\n`);
}

/**
 * The `pair` subcommand. Initiates the device grant as a first-class
 * device-flow client: if a valid pairing already exists (and a refresh, when
 * needed, succeeds), print its status and exit — else start a fresh grant,
 * print the user_code + approval URL, poll-and-exchange the device_code, and
 * persist the credentials (incl. refresh_token) to the pairing file.
 */
export interface RunPairOptions {
  /** Browser-launch seam for tests (default openBrowser). */
  open?: (url: string) => boolean;
}

export async function runPair(args: string[], options: RunPairOptions = {}): Promise<void> {
  const url = parseApiUrl(args);

  // Required, deliberately — not defaulted from API_URL or localhost. The
  // pairing credential is stored in a file keyed by a hash of the backend url,
  // so a pairing made against one backend is invisible to an MCP server running
  // against another: the server finds nothing, sends no presence heartbeat, and
  // the review UI reports "paired but unreachable" with nothing on either side
  // naming the cause. Inferring a default is what made that mismatch easy to
  // hit and impossible to see, so the backend must be stated.
  if (!url) {
    process.stderr.write(
      'actorium-mcp: --api-url is required\n' +
        '  usage: actorium-mcp pair --api-url <url> [--handle <name>] [--no-open]\n' +
        '  It must match the API_URL your editor runs actorium-mcp with; the exact\n' +
        '  command for your deployment is in Settings → Local agent.\n',
    );
    process.exitCode = 1;
    return;
  }

  if (!/^https?:\/\//i.test(url)) {
    process.stderr.write(
      `actorium-mcp: --api-url must be an absolute http(s) url, got ${JSON.stringify(url)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig({ bffUrl: url });
  const bffUrl = config.bffUrl;
  const handle = parseHandle(args) ?? defaultHandle();

  process.stdout.write(`Pairing with ${bffUrl}\n`);

  // Always a fresh grant. Reusing a cached credential made `pair` a silent
  // no-op whenever the local file and the server disagreed — the file says
  // paired, the server has no record, and re-running only ever reprinted the
  // stale credential. Re-pairing is cheap and supersedes the previous pairing
  // server-side, so the safe default is to just do it.
  const started = await deviceFlow.start(bffUrl, {
    client_id: deviceFlow.PAIRING_CLIENT_ID,
    handle,
  });
  // Prefer the pre-filled url (RFC 8628 verification_uri_complete): it carries
  // the user_code in the query string, so an opened browser needs no typing.
  const approvalUrl = started.verification_uri_complete || started.verification_uri;
  process.stdout.write(`Open ${approvalUrl}\n`);
  process.stdout.write(`and enter code: ${started.user_code}\n`);

  const open = options.open ?? openBrowser;
  if (!parseNoOpen(args) && open(approvalUrl)) {
    process.stdout.write('Opening your browser… (pass --no-open to skip)\n');
  }

  const tokens = await deviceFlow.pollAndExchange(
    bffUrl,
    started.device_code,
    deviceFlow.PAIRING_CLIENT_ID,
    {
      intervalMs: (started.interval ?? 5) * 1000,
      deadlineMs: (started.expires_in ?? 600) * 1000,
    },
  );

  const creds = toCredentials(tokens, deviceFlow.PAIRING_CLIENT_ID, handle, bffUrl);
  savePairing(bffUrl, creds);
  printStatus(creds);
}

/**
 * The `pairings` subcommand: lists every backend this machine is paired to.
 *
 * A pairing is only usable by an MCP server running with the same API_URL, so
 * the thing worth showing is the backend each pairing belongs to — that is what
 * you compare against your editor's MCP config when an agent pairs fine but
 * never comes online.
 */
export function runPairings(homeDir?: string): void {
  const pairings = listPairings(homeDir);

  if (pairings.length === 0) {
    process.stdout.write('No local pairings.\n');
    process.stdout.write('  Pair one with: actorium-mcp pair --api-url <url> --handle <name>\n');
    return;
  }

  process.stdout.write(`${pairings.length} local pairing${pairings.length === 1 ? '' : 's'}:\n`);
  for (const p of pairings) {
    process.stdout.write(`  @${p.handle ?? 'local-agent'}\n`);
    process.stdout.write(`    backend: ${p.bffUrl}\n`);
    process.stdout.write(`    access token expires: ${new Date(accessTokenExpiry(p)).toISOString()}\n`);
  }
  process.stdout.write(
    "\nEach pairing only works for an MCP server started with that backend as API_URL.\n",
  );
}

/**
 * The `unpair` subcommand: revokes this machine's pairing for a backend and
 * deletes the local credential.
 *
 * Revocation has to be reachable without a browser. The paired agent holds no
 * session cookie, so the BFF accepts a pairing's own bearer token to end that
 * same pairing (and only that one). The local file is removed regardless of
 * what the server says: a credential left on disk for a pairing the server has
 * dropped is exactly the stale state that makes `pair` look like it worked
 * while nothing is registered.
 */
export async function runUnpair(args: string[], homeDir?: string): Promise<void> {
  const url = parseApiUrl(args);
  if (!url) {
    process.stderr.write(
      'actorium-mcp: --api-url is required\n  usage: actorium-mcp unpair --api-url <url>\n',
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig({ bffUrl: url });
  const bffUrl = config.bffUrl;
  const participant = await resolveFreshParticipant(config, { homeDir });

  if (!participant) {
    process.stdout.write(`No pairing for ${bffUrl} — nothing to unpair.\n`);
    return;
  }

  const endpoint = `${bffUrl.replace(/\/$/, '')}/oauth/device/pairings/${encodeURIComponent(participant.participantId)}`;
  try {
    const response = await fetch(endpoint, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${participant.accessToken}` },
    });
    if (response.ok || response.status === 404) {
      process.stdout.write(`Unpaired from ${bffUrl}.\n`);
    } else {
      process.stderr.write(
        `actorium-mcp: server refused the unpair (HTTP ${response.status}); removing the local credential anyway.\n`,
      );
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(
      `actorium-mcp: could not reach ${bffUrl} (${err instanceof Error ? err.message : String(err)}); ` +
        'removing the local credential anyway — revoke it in Settings if it is still listed.\n',
    );
    process.exitCode = 1;
  }

  try {
    fs.rmSync(pairingPath(bffUrl, homeDir ?? os.homedir()));
  } catch {
    // already gone
  }
}
