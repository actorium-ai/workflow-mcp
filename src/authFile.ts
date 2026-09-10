/**
 * Credential precedence for MCP tools (see config.ts).
 *
 * `loadConfig` checks the `WORKFLOW_TOKEN` env var first (back-compat, and
 * what CI/headless always wants), and otherwise falls back to this module's
 * `auth.<hash>.json` — the credential file the workflow-extension VS Code
 * extension maintains. This one file backs everything: the read-only tools
 * in tools.ts, and the review tools/channel in reviewTools.ts/channel.ts,
 * which derive their `agent_participant_id` straight from this same access
 * token's JWT claims (see channel.ts's resolveParticipant) — there is no
 * separate pairing credential.
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
  /** Display identity for the account this token belongs to — surfaced in
   * BffClient's 401 error message (see config.ts's accountLabel). */
  accountEmail?: string;
  accountDisplayName?: string;
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
 * Path to the per-account credential file — same bffUrl hash as
 * credentialFilePath, plus an opaque account key (sha256 of the account id,
 * hashed on the extension side — see credentialFile.ts's accountKeyFor —
 * this side never sees or needs the raw account id). Two accounts signed in
 * against the same bffUrl each get their own file here instead of fighting
 * over the single legacy file.
 */
export function accountCredentialFilePath(
  bffUrl: string,
  accountKey: string,
  homeDir: string = os.homedir(),
): string {
  const key = crypto.createHash('sha256').update(bffUrl).digest('hex').slice(0, 16);
  return path.join(homeDir, '.actorium', `auth.${key}.${accountKey}.json`);
}

function parseStoredCredentials(raw: string): StoredCredentials | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) return null;
    return {
      accessToken: parsed.accessToken,
      orgId: typeof parsed.orgId === 'string' ? parsed.orgId : undefined,
      workspaceId: typeof parsed.workspaceId === 'string' ? parsed.workspaceId : undefined,
      bffUrl: typeof parsed.bffUrl === 'string' ? parsed.bffUrl : undefined,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      accountEmail: typeof parsed.accountEmail === 'string' ? parsed.accountEmail : undefined,
      accountDisplayName:
        typeof parsed.accountDisplayName === 'string' ? parsed.accountDisplayName : undefined,
    };
  } catch {
    return null;
  }
}

function readCredentialFileAt(filePath: string): StoredCredentials | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  return parseStoredCredentials(raw);
}

/**
 * Reads the credential file for `bffUrl`. Returns null on any failure
 * (missing file, unreadable, malformed JSON, wrong shape) — callers fall back
 * to env-var config rather than throwing, since the file simply not existing
 * (extension never connected to this backend, or connected on a machine
 * without it) is the expected steady state for env-var/CI usage.
 *
 * When `accountKey` is given (from ACTORIUM_ACCOUNT_KEY — see config.ts),
 * the account-scoped file is tried first; a missing account-scoped file
 * falls back to the legacy bffUrl-only file, covering a registration made
 * before per-account files existed, or a brief window before the extension's
 * first sync after upgrading.
 */
export function readCredentialFile(
  bffUrl: string,
  homeDir: string = os.homedir(),
  accountKey?: string,
): StoredCredentials | null {
  if (accountKey) {
    const viaAccount = readCredentialFileAt(accountCredentialFilePath(bffUrl, accountKey, homeDir));
    if (viaAccount) return viaAccount;
  }
  return readCredentialFileAt(credentialFilePath(bffUrl, homeDir));
}
