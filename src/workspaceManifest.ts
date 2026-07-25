import * as fs from 'fs';
import * as path from 'path';

export interface WorkspaceManifest {
  workspaceId: string;
  orgId: string;
}

const MANIFEST_RELATIVE_PATH = path.join('.actorium', 'workspace.json');
const MAX_UPWARD_SEARCH_DEPTH = 20;

/**
 * Walks upward from `startDir` (default `process.cwd()`) looking for
 * `.actorium/workspace.json` — written by the Actorium VS Code extension at
 * a workspace folder's root (see its src/workspace/workspaceManifest.ts,
 * which must stay in sync with this exact relative path/shape).
 *
 * Lets actorium-mcp resolve which specific workspace it's running for
 * directly from its own cwd — correct even when multiple VS Code windows
 * are open on different workspaces simultaneously, unlike the shared
 * credential file's defaultWorkspaceId/defaultOrgId (see authFile.ts),
 * which only ever reflects whichever window most recently synced it.
 * config.ts prefers this over the credential file's values when both are
 * available.
 */
export function findWorkspaceManifest(startDir: string = process.cwd()): WorkspaceManifest | null {
  let dir = startDir;
  for (let i = 0; i < MAX_UPWARD_SEARCH_DEPTH; i++) {
    const manifestPath = path.join(dir, MANIFEST_RELATIVE_PATH);
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<WorkspaceManifest>;
      if (typeof parsed.workspaceId === 'string' && typeof parsed.orgId === 'string') {
        return { workspaceId: parsed.workspaceId, orgId: parsed.orgId };
      }
      return null; // found but malformed — don't keep walking past a bad file
    } catch {
      // not found at this level — keep walking up
    }

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}
