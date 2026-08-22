import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Credentials a paired local agent persists after the device-flow grant
 * completes (see deviceFlow.ts / pair.ts). The `refresh_token` is what makes
 * the pair durable — the access token is short-lived (1h for the pairing
 * client) and is re-minted from the refresh token on each refresh.
 */
export interface PairingCredentials {
  accessToken: string;
  refreshToken: string;
  /** `expires_in` from the token response, in seconds. */
  expiresIn?: number;
  tokenType?: string;
  handle?: string;
  clientId?: string;
  bffUrl?: string;
  updatedAt: number;
}

/** The pairing file is a credential — never world/group readable. */
const FILE_MODE = 0o600;

/**
 * Path to the local agent's own pairing credential file.
 *
 * Same deterministic hash derivation as authFile.ts's `credentialFilePath`
 * (sha256 of `bffUrl`, first 16 hex chars) but a DISTINCT filename prefix
 * (`pairing.` vs `auth.`) so the pair command never clobbers the credential
 * file the workflow-extension VS Code extension writes — see authFile.ts for
 * why the hash is keyed by `bffUrl`. The two files coexist for the same
 * backend: the extension's `auth.<hash>.json` identifies the developer's own
 * user token, while `pairing.<hash>.json` identifies the paired local-agent
 * participant.
 *
 * `homeDir` defaults to `os.homedir()` and only exists as a seam for tests
 * (same pattern as authFile.ts's `homeDir` param).
 */
export function pairingPath(bffUrl: string, homeDir: string = os.homedir()): string {
  const key = crypto.createHash('sha256').update(bffUrl).digest('hex').slice(0, 16);
  return path.join(homeDir, '.actorium', `pairing.${key}.json`);
}

/**
 * Reads the pairing credential file for `bffUrl`. Returns null on any failure
 * (missing file, unreadable, malformed JSON, missing access/refresh token) —
 * callers treat a missing/expired pairing as "not paired" and start a fresh
 * device-flow grant rather than throwing.
 *
 * Unlike authFile.ts's `readCredentialFile` (which only requires an access
 * token), a pairing is only usable if BOTH tokens are present: the refresh
 * token is the durable credential, so an access-token-only file is treated as
 * absent rather than half-paired.
 */
export function loadPairing(bffUrl: string, homeDir: string = os.homedir()): PairingCredentials | null {
  let raw: string;
  try {
    raw = fs.readFileSync(pairingPath(bffUrl, homeDir), 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PairingCredentials>;
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) return null;
    if (typeof parsed.refreshToken !== 'string' || !parsed.refreshToken) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresIn: typeof parsed.expiresIn === 'number' ? parsed.expiresIn : undefined,
      tokenType: typeof parsed.tokenType === 'string' ? parsed.tokenType : undefined,
      handle: typeof parsed.handle === 'string' ? parsed.handle : undefined,
      clientId: typeof parsed.clientId === 'string' ? parsed.clientId : undefined,
      bffUrl: typeof parsed.bffUrl === 'string' ? parsed.bffUrl : undefined,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Writes the pairing credential file for `bffUrl` with mode 0600, creating the
 * `.actorium` directory if needed. Only ever touches `pairing.<hash>.json` —
 * never the extension's `auth.<hash>.json` (see pairingPath's doc comment).
 */
export function savePairing(
  bffUrl: string,
  creds: PairingCredentials,
  homeDir: string = os.homedir(),
): void {
  const filePath = pairingPath(bffUrl, homeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(creds, null, 2), { mode: FILE_MODE });
  // chmod again for the overwrite case: writeFileSync's mode only applies on
  // file creation, so an existing looser-permissioned file would otherwise
  // keep its old mode across a save.
  fs.chmodSync(filePath, FILE_MODE);
}

/**
 * Lists every pairing this machine holds, newest first.
 *
 * Pairings are per-backend by design — the file name is derived from the
 * backend url (see pairingPath), so one machine can be paired to a local
 * stack, a staging deployment and production at the same time without them
 * colliding. The cost of that is invisibility: nothing else surfaces which
 * backends you are actually paired to, which is how "pair succeeded but the
 * agent never comes online" (pairing and MCP server on different backends)
 * goes unnoticed. Unreadable/foreign files in the directory are skipped.
 */
export function listPairings(homeDir: string = os.homedir()): PairingCredentials[] {
  const dir = path.join(homeDir, '.actorium');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const out: PairingCredentials[] = [];
  for (const name of names) {
    if (!name.startsWith('pairing.') || !name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Partial<PairingCredentials>;
      if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) continue;
      if (typeof parsed.bffUrl !== 'string' || !parsed.bffUrl) continue;
      out.push(parsed as PairingCredentials);
    } catch {
      // not ours, or unreadable — skip rather than fail the whole listing
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
