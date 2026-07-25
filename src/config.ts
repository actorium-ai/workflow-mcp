import { readCredentialFile } from './authFile.js';
import { findWorkspaceManifest } from './workspaceManifest.js';

export interface Config {
  bffUrl: string;
  /** Bearer JWT — populated from WORKFLOW_TOKEN, or from the shared
   * credential file the workflow-extension VS Code extension maintains (see
   * bffClient.ts). */
  bearerToken?: string;
  /** Workspace UUID to use when a tool call omits workspace_id — there's no
   * env-var override (an explicit tool call argument always wins regardless
   * of this); see loadConfig's doc comment for where this value comes from. */
  defaultWorkspaceId?: string;
  /** Organization UUID to use when a tool call omits org_id (currently just
   * list_workspaces) — same sourcing as defaultWorkspaceId. */
  defaultOrgId?: string;
}

const DEFAULT_BFF_URL = 'http://localhost:8090';

/**
 * Precedence: explicit WORKFLOW_TOKEN env var first (back-compat, and what
 * CI/headless use always wants — an explicit override should never be
 * silently shadowed by whatever the extension last wrote), then the shared
 * credential file the workflow-extension VS Code extension maintains (see
 * authFile.ts), so a normal interactive setup needs no env vars at all.
 *
 * defaultWorkspaceId/defaultOrgId are resolved differently: the cwd-based
 * workspace manifest (see workspaceManifest.ts) wins over the credential
 * file's stored values whenever actorium-mcp is running from inside a linked
 * workspace folder — the credential file is a single machine-wide "last
 * selected" value, so with multiple VS Code windows open on different
 * workspaces it only reflects whichever window synced most recently. The
 * manifest instead answers "which workspace is THIS folder for" directly,
 * which stays correct regardless of what any other window/process is doing.
 */
export function loadConfig(): Config {
  const bffUrl = process.env.API_URL ?? DEFAULT_BFF_URL;
  const envBearerToken = process.env.WORKFLOW_TOKEN;
  const cwdWorkspace = findWorkspaceManifest();

  if (envBearerToken) {
    return {
      bffUrl,
      bearerToken: envBearerToken,
      defaultWorkspaceId: cwdWorkspace?.workspaceId,
      defaultOrgId: cwdWorkspace?.orgId,
    };
  }

  const stored = readCredentialFile();
  if (stored) {
    return {
      bffUrl,
      bearerToken: stored.accessToken,
      defaultWorkspaceId: cwdWorkspace?.workspaceId ?? stored.workspaceId,
      defaultOrgId: cwdWorkspace?.orgId ?? stored.orgId,
    };
  }

  return {
    bffUrl,
    defaultWorkspaceId: cwdWorkspace?.workspaceId,
    defaultOrgId: cwdWorkspace?.orgId,
  };
}
