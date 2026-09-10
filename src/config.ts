import * as os from 'os';
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
  /** Display label (email/display name) for the account bearerToken belongs
   * to — surfaced in BffClient's 401 error message. */
  accountLabel?: string;
}

export const DEFAULT_BFF_URL = 'http://localhost:8090';

/** Overrides applied on top of the environment — a test/CLI seam for callers
 * that resolve the backend themselves. */
export interface ConfigOverrides {
  bffUrl?: string;
  /** Overrides ACTORIUM_ACCOUNT_KEY — a test/CLI seam, same pattern as
   * bffUrl above. */
  accountKey?: string;
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
 *
 * `accountKey` (from ACTORIUM_ACCOUNT_KEY, baked into each CLI's MCP
 * registration alongside API_URL — see workflow-extension's mcpConnect.ts)
 * selects a per-account credential file when present, so two accounts
 * registered against the same bffUrl don't clobber each other. Absent, this
 * falls back to the legacy bffUrl-only file exactly as before — a
 * registration made before ACTORIUM_ACCOUNT_KEY existed keeps working
 * unmodified.
 *
 * This is intentionally cheap to call repeatedly (a small local JSON read) —
 * callers should call it fresh per use rather than caching the result, so a
 * token renewed or an account switched mid-process is picked up immediately
 * (see BffClient's class doc).
 */
export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const bffUrl = overrides.bffUrl ?? process.env.API_URL ?? DEFAULT_BFF_URL;
  const accountKey = overrides.accountKey ?? process.env.ACTORIUM_ACCOUNT_KEY;
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

  const stored = readCredentialFile(bffUrl, os.homedir(), accountKey);
  if (stored) {
    return {
      bffUrl,
      bearerToken: stored.accessToken,
      defaultWorkspaceId: cwdWorkspace?.workspaceId ?? stored.workspaceId,
      defaultOrgId: cwdWorkspace?.orgId ?? stored.orgId,
      accountLabel: stored.accountDisplayName ?? stored.accountEmail,
    };
  }

  return {
    bffUrl,
    defaultWorkspaceId: cwdWorkspace?.workspaceId,
    defaultOrgId: cwdWorkspace?.orgId,
  };
}
