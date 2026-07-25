import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface StoredCredentials {
  accessToken: string;
  orgId?: string;
  workspaceId?: string;
  updatedAt: number;
}

/**
 * Path to the credential file the workflow-extension VS Code extension writes
 * (packages/vscode/src/auth/oauth.ts) whenever its OAuth device-flow token or
 * selected org/workspace changes. Shared across both projects so workflow-mcp
 * never needs its own login step — see each repo's AGENTS.md for the auth
 * story this supports.
 */
export function credentialFilePath(): string {
  return path.join(os.homedir(), '.actorium', 'auth.json');
}

/**
 * Reads the shared credential file. Returns null on any failure (missing
 * file, unreadable, malformed JSON, wrong shape) — callers fall back to
 * env-var config rather than throwing, since the file simply not existing
 * (extension never connected, or connected on a machine without it) is the
 * expected steady state for env-var/CI usage.
 */
export function readCredentialFile(): StoredCredentials | null {
  let raw: string;
  try {
    raw = fs.readFileSync(credentialFilePath(), 'utf8');
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
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}
