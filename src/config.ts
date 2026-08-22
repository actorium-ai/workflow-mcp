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

export const DEFAULT_BFF_URL = 'http://localhost:8090';

/** Overrides applied on top of the environment, for callers that resolve the
 * backend themselves (the `pair` subcommand's --api-url flag). */
export interface ConfigOverrides {
  bffUrl?: string;
}

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
 * workspace folder. The credential file itself is now keyed by `bffUrl` (see
 * authFile.ts) — one VS Code window per backend — so even without a manifest
 * it already reflects the right backend's own selection, not just whichever
 * window/environment happened to sync most recently. The manifest still wins
 * when present since it answers "which workspace is THIS folder for"
 * directly, which stays correct regardless of what any other window/process
 * is doing.
 */
export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const bffUrl = overrides.bffUrl ?? process.env.API_URL ?? DEFAULT_BFF_URL;
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

  const stored = readCredentialFile(bffUrl);
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
