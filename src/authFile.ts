/**
 * Credential precedence for read-only MCP tools (see config.ts):
 *
 *   1. the extension's credential file (`auth.<hash>.json`) — this module;
 *   2. the pairing credential file (`pairing.<hash>.json`) — pairingStore.ts;
 *   3. the `WORKFLOW_TOKEN` env var.
 *
 * The `pair` subcommand, the review channel, and the review tools use
 * `pairing.<hash>.json` only — it identifies the paired local-agent
 * participant, whereas `auth.<hash>.json` identifies the developer's own user
 * token. The two files coexist per backend (same sha256-of-`bffUrl` hash
 * derivation, distinct filename prefix) so pairing never clobbers the file
 * the workflow-extension VS Code extension writes.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface StoredCredentials {
  accessToken: string;
  orgId?: string;
  workspaceId?: string;
  bffUrl?: string;
  updatedAt: number;
}

/**
 * Path to the credential file the workflow-extension VS Code extension writes
 * (packages/vscode/src/auth/oauth.ts, credentialFile.ts) whenever its OAuth
 * device-flow token or selected org/workspace changes. Shared across both
 * projects so workflow-mcp never needs its own login step — see each repo's
 * AGENTS.md for the auth story this supports.
 *
 * One file per backend (`bffUrl`), not a single flat file: a VS Code window
 * can point at any `actorium.environment`/`bffUrl` independently of any other
 * open window (window-scoped setting), and each backend issues its own JWT —
 * a single shared file could only ever hold one backend's token, clobbered by
 * whichever window/environment synced last, handing this process a token for
 * the wrong server. The filename is a deterministic hash of `bffUrl` (sha256,
 * first 16 hex chars) so this side can compute the same path from its own
 * `API_URL` with zero coordination beyond the hash function itself — see
 * workflow-extension's credentialFile.ts for the writing side of this same
 * derivation. Hash the string EXACTLY as received (no trailing-slash
 * stripping, no case-folding) — any normalization drift between the two sides
 * silently breaks the lookup.
 *
 * `homeDir` defaults to `os.homedir()` and only exists as a seam for tests
 * (same pattern as workspaceManifest.ts's `startDir` param) — os.homedir()
 * already resolves correctly on Windows/macOS/Linux on its own, so
 * production callers never need to pass it.
 */
export function credentialFilePath(bffUrl: string, homeDir: string = os.homedir()): string {
  const key = crypto.createHash('sha256').update(bffUrl).digest('hex').slice(0, 16);
  return path.join(homeDir, '.actorium', `auth.${key}.json`);
}

/**
 * Reads the credential file for `bffUrl`. Returns null on any failure
 * (missing file, unreadable, malformed JSON, wrong shape) — callers fall back
 * to env-var config rather than throwing, since the file simply not existing
 * (extension never connected to this backend, or connected on a machine
 * without it) is the expected steady state for env-var/CI usage.
 */
export function readCredentialFile(
  bffUrl: string,
  homeDir: string = os.homedir(),
): StoredCredentials | null {
  let raw: string;
  try {
    raw = fs.readFileSync(credentialFilePath(bffUrl, homeDir), 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) return null;
    return {
      accessToken: parsed.accessToken,
      orgId: typeof parsed.orgId === 'string' ? parsed.orgId : undefined,
      workspaceId: typeof parsed.workspaceId === 'string' ? parsed.workspaceId : undefined,
      bffUrl: typeof parsed.bffUrl === 'string' ? parsed.bffUrl : undefined,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}
