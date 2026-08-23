import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BffClient, BffRequestError } from './bffClient.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export type ToolResult = CallToolResult;

function formatBffError(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Compact (no pretty-print indent) — every tool response here gets fed
// straight into a coding agent's context window, so the whitespace/newlines
// a pretty-printed JSON.stringify adds is pure wasted tokens with no
// readability benefit to the model consuming it.
function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function notFoundResult(reason: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason }) }], isError: true };
}

// ── get_feature ──────────────────────────────────────────────────────────────

export interface Feature {
  id: string;
  feature_id: string;
  feature_name: string;
  title: string;
  status: string;
  current_stage: string;
  owner?: string;
}

export interface FeaturesResponse {
  success: boolean;
  data: {
    items: Feature[];
    total: number;
    page: number;
    limit: number;
  };
}

/** The feature-detail endpoint's response — bundles what used to take several
 * separate tool calls (docs, tasks, activity, sync state) into one. `tasks`/
 * `activity`/`documents`/`source_state`/`task_counts` are relayed as-is
 * (server-defined shapes) rather than fully re-typed here. */
export interface FeatureDetail {
  id: string;
  feature_name: string;
  title: string;
  status: string;
  current_stage: string;
  next_action?: string;
  owner?: string;
  updated_at?: string;
  workspace_id: string;
  task_counts?: Record<string, number>;
  documents?: unknown[];
  tasks?: unknown[];
  activity?: unknown[];
  source_state?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FeatureDetailResponse {
  success: boolean;
  data: FeatureDetail;
}

async function resolveFeatureUuid(
  workspaceId: string,
  feature: string,
  bffClient: BffClient,
): Promise<{ featureUuid: string } | { error: ToolResult }> {
  if (isUuid(feature)) return { featureUuid: feature };

  let response: FeaturesResponse;
  try {
    response = await bffClient.get<FeaturesResponse>(
      `/bff/workflow-backend/api/workspaces/${encodeURIComponent(workspaceId)}/features?name=${encodeURIComponent(feature)}`,
    );
  } catch (err) {
    return { error: formatBffError(err) };
  }

  const features = response.data?.items ?? [];
  if (features.length === 0) {
    return { error: notFoundResult(`feature_not_found: "${feature}" in workspace ${workspaceId}`) };
  }
  return { featureUuid: features[0].id };
}

/**
 * Resolves a feature by name (or UUID) and returns its FULL detail —
 * documents, tasks, activity timeline, and sync state bundled in one call by
 * workflow-backend's own GetFeature endpoint (previously this tool only
 * returned the bare summary from the search-by-name list endpoint).
 */
export async function handleGetFeature(
  args: { workspace_id: string; name: string },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, name } = args;

  const resolved = await resolveFeatureUuid(workspace_id, name, bffClient);
  if ('error' in resolved) return resolved.error;

  try {
    const detail = await bffClient.get<FeatureDetailResponse>(
      `/bff/workflow-backend/api/workspaces/${encodeURIComponent(workspace_id)}/features/${encodeURIComponent(resolved.featureUuid)}`,
    );
    return jsonResult(detail.data);
  } catch (err) {
    return formatBffError(err);
  }
}

// ── list_workspaces ───────────────────────────────────────────────────────────

export interface WorkspaceSummary {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  [key: string]: unknown;
}

export interface WorkspacesResponse {
  success: boolean;
  data: WorkspaceSummary[];
}

export async function handleListWorkspaces(
  args: { org_id: string },
  bffClient: BffClient,
): Promise<ToolResult> {
  try {
    const response = await bffClient.get<WorkspacesResponse>(
      `/bff/workflow-backend/api/workspaces?org=${encodeURIComponent(args.org_id)}`,
    );
    return jsonResult(response.data);
  } catch (err) {
    return formatBffError(err);
  }
}

// ── search_features ────────────────────────────────────────────────────────────

export interface SearchFeaturesArgs {
  workspace_id: string;
  status?: string;
  title?: string;
  sort?: string;
  page?: number;
  limit?: number;
  include_tasks?: boolean;
}

export async function handleSearchFeatures(
  args: SearchFeaturesArgs,
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, status, title, sort, page, limit, include_tasks } = args;
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (title) qs.set('title', title);
  if (sort) qs.set('sort', sort);
  if (page !== undefined) qs.set('page', String(page));
  if (limit !== undefined) qs.set('limit', String(limit));
  if (include_tasks) qs.set('include', 'tasks');

  try {
    const query = qs.toString();
    const response = await bffClient.get<{ success: boolean; data: unknown }>(
      `/bff/workflow-backend/api/workspaces/${encodeURIComponent(workspace_id)}/features${query ? `?${query}` : ''}`,
    );
    return jsonResult(response.data);
  } catch (err) {
    return formatBffError(err);
  }
}

// ── search_tasks ────────────────────────────────────────────────────────────

export interface SearchTasksArgs {
  workspace_id: string;
  feature_id?: string;
  task_id?: string;
  title?: string;
  status?: string;
  repo?: string;
  sort?: string;
  page?: number;
  limit?: number;
}

export async function handleSearchTasks(args: SearchTasksArgs, bffClient: BffClient): Promise<ToolResult> {
  const { workspace_id, feature_id, task_id, title, status, repo, sort, page, limit } = args;
  const qs = new URLSearchParams();
  if (task_id) qs.set('task_id', task_id);
  if (title) qs.set('title', title);
  if (status) qs.set('status', status);
  if (repo) qs.set('repo', repo);
  if (sort) qs.set('sort', sort);
  if (page !== undefined) qs.set('page', String(page));
  if (limit !== undefined) qs.set('limit', String(limit));

  const base = feature_id
    ? `/bff/workflow-backend/api/workspaces/${encodeURIComponent(workspace_id)}/features/${encodeURIComponent(feature_id)}/tasks`
    : `/bff/workflow-backend/api/workspaces/${encodeURIComponent(workspace_id)}/tasks`;

  try {
    const query = qs.toString();
    const response = await bffClient.get<{ success: boolean; data: unknown }>(
      `${base}${query ? `?${query}` : ''}`,
    );
    return jsonResult(response.data);
  } catch (err) {
    return formatBffError(err);
  }
}

// ── get_task ────────────────────────────────────────────────────────────────

export async function handleGetTask(
  args: { workspace_id: string; task_id: string },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, task_id } = args;
  try {
    const response = await bffClient.get<{ success: boolean; data: unknown }>(
      `/bff/workflow-backend/api/workspaces/${encodeURIComponent(workspace_id)}/tasks/${encodeURIComponent(task_id)}`,
    );
    return jsonResult(response.data);
  } catch (err) {
    if (err instanceof BffRequestError && err.status === 404) {
      return notFoundResult(`task_not_found: "${task_id}" in workspace ${workspace_id}`);
    }
    return formatBffError(err);
  }
}

// ── get_task_diff / get_task_review_thread ──────────────────────────────────

export async function handleGetTaskDiff(
  args: { workspace_id: string; task_id: string; repo?: string; files_only?: boolean },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, task_id, repo, files_only } = args;
  const params = new URLSearchParams();
  if (repo) params.set('repo', repo);
  if (files_only) params.set('files_only', 'true');
  const query = params.toString();
  const qs = query ? `?${query}` : '';
  try {
    const response = await bffClient.get<{ success: boolean; data: unknown }>(
      `/bff/workflow-backend/api/workspaces/${encodeURIComponent(workspace_id)}/tasks/${encodeURIComponent(task_id)}/diff${qs}`,
    );
    return jsonResult(response.data);
  } catch (err) {
    if (err instanceof BffRequestError && err.status === 404) {
      return notFoundResult(`task_not_found: "${task_id}" in workspace ${workspace_id}`);
    }
    return formatBffError(err);
  }
}

export async function handleGetTaskReviewThread(
  args: { workspace_id: string; task_id: string; repo?: string },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, task_id, repo } = args;
  const qs = repo ? `?repo=${encodeURIComponent(repo)}` : '';
  try {
    const response = await bffClient.get<{ success: boolean; data: unknown }>(
      `/bff/workflow-backend/api/workspaces/${encodeURIComponent(workspace_id)}/tasks/${encodeURIComponent(task_id)}/review-thread${qs}`,
    );
    return jsonResult(response.data);
  } catch (err) {
    if (err instanceof BffRequestError && err.status === 404) {
      return notFoundResult(`task_not_found: "${task_id}" in workspace ${workspace_id}`);
    }
    return formatBffError(err);
  }
}

// ── get_feature_handoff ──────────────────────────────────────────────────────

export async function handleGetFeatureHandoff(
  args: { workspace_id: string; feature_id: string },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, feature_id } = args;
  try {
    const response = await bffClient.get<{ success: boolean; data: unknown }>(
      `/bff/workflow-backend/api/workspaces/${encodeURIComponent(workspace_id)}/features/${encodeURIComponent(feature_id)}/handoff`,
    );
    return jsonResult(response.data);
  } catch (err) {
    if (err instanceof BffRequestError && err.status === 404) {
      return notFoundResult(
        `handoff_not_found: feature ${feature_id} is not go-owned, or has no handoff yet`,
      );
    }
    return formatBffError(err);
  }
}

// ── list_workspace_activity ──────────────────────────────────────────────────

export async function handleListWorkspaceActivity(
  args: {
    workspace_id: string;
    feature_id?: string;
    task_id?: string;
    audience?: 'internal' | 'client';
    page?: number;
    limit?: number;
  },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, feature_id, task_id, audience, page, limit } = args;
  const qs = new URLSearchParams();
  if (feature_id) qs.set('featureId', feature_id);
  if (task_id) qs.set('taskId', task_id);
  if (audience) qs.set('audience', audience);
  if (page !== undefined) qs.set('page', String(page));
  if (limit !== undefined) qs.set('limit', String(limit));

  try {
    const query = qs.toString();
    const response = await bffClient.get<{ success: boolean; data: unknown }>(
      `/bff/workflow-backend/api/workspaces/${encodeURIComponent(workspace_id)}/activity${query ? `?${query}` : ''}`,
    );
    return jsonResult(response.data);
  } catch (err) {
    return formatBffError(err);
  }
}

// ── list_workspace_repos ─────────────────────────────────────────────────────

export async function handleListWorkspaceRepos(
  args: { workspace_id: string },
  bffClient: BffClient,
): Promise<ToolResult> {
  try {
    const response = await bffClient.get<{ success: boolean; data: unknown }>(
      `/bff/workflow-backend/api/workspaces/${encodeURIComponent(args.workspace_id)}/repos`,
    );
    return jsonResult(response.data);
  } catch (err) {
    return formatBffError(err);
  }
}

// ── read_storage_document ─────────────────────────────────────────────────────

export type DocumentKind = 'product_spec' | 'technical_design' | 'tasks' | 'handoff';

export interface DocumentContentResponse {
  content: string;
}

/** Canonical per-feature filename for each document kind — storage-service
 * keys documents by feature-relative PATH, not by this "kind" vocabulary
 * (see documentContentPath below), so every caller needs this mapping. */
const KIND_TO_FILENAME: Record<DocumentKind, string> = {
  product_spec: 'product_spec.md',
  technical_design: 'tech_design.md',
  tasks: 'tasks.md',
  handoff: 'handoff.md',
};

/**
 * Builds the real storage-service content route:
 * `.../documents/content?path=<relative-filename>` — NOT `.../documents/:kind/content`
 * (that route doesn't exist; storage-service's handler.go registers
 * `/documents/content` with `path` as a query param, confirmed directly against
 * the source). Mirrors the Actorium VS Code extension's own
 * toFeatureRelativePath/getDocumentContent (workflow-api.ts).
 *
 * featureId omitted/empty targets storage-service's no-`:fid` sibling route — a
 * document with no owning feature (a workspace-root file, e.g. one uploaded
 * outside any feature's folder in the Files browser), where path is then
 * relative to the workspace root instead of a feature folder.
 */
function documentContentUrl(workspaceId: string, featureId: string | undefined, path: string): string {
  const qs = new URLSearchParams({ path });
  const base = featureId
    ? `/bff/storage-service/api/workspaces/${encodeURIComponent(workspaceId)}/features/${encodeURIComponent(featureId)}/documents/content`
    : `/bff/storage-service/api/workspaces/${encodeURIComponent(workspaceId)}/documents/content`;
  return `${base}?${qs}`;
}

/**
 * Resolves the caller's `kind`/`path` pair (see the read/create/update tools'
 * shared inputSchema shape) to the single relative path storage-service's
 * content route needs. `kind` is sugar for the four canonical per-feature
 * documents (see KIND_TO_FILENAME) — it only makes sense with feature_id set,
 * since those are always feature-scoped. `path` is the general escape hatch:
 * any other document, feature-scoped or workspace-root (feature_id omitted).
 */
function resolveDocPath(
  featureId: string | undefined,
  kind: DocumentKind | undefined,
  path: string | undefined,
): { path: string } | { error: ToolResult } {
  if (kind && path) {
    return { error: notFoundResult('invalid_args: pass exactly one of kind or path, not both') };
  }
  if (!kind && !path) {
    return {
      error: notFoundResult(
        'invalid_args: pass kind (for a canonical feature document) or path (for any other ' +
          'document, including a workspace-root document with no feature_id)',
      ),
    };
  }
  if (kind && !featureId) {
    return {
      error: notFoundResult(
        `invalid_args: kind="${kind}" requires feature_id — canonical documents are feature-scoped; ` +
          'pass path instead for a workspace-root document',
      ),
    };
  }
  return { path: kind ? KIND_TO_FILENAME[kind] : (path as string) };
}

/** Human-readable "what/where" for a document_not_found reason string. */
function docLabel(featureId: string | undefined, kind: DocumentKind | undefined, path: string): string {
  const where = featureId ? `feature ${featureId}` : 'workspace root';
  return kind ? `kind="${kind}" in ${where}` : `path="${path}" in ${where}`;
}

export async function handleReadStorageDocument(
  args: { workspace_id: string; feature_id?: string; kind?: DocumentKind; path?: string },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, feature_id, kind, path } = args;
  const resolved = resolveDocPath(feature_id, kind, path);
  if ('error' in resolved) return resolved.error;
  try {
    const response = await bffClient.get<DocumentContentResponse>(
      documentContentUrl(workspace_id, feature_id, resolved.path),
    );
    return { content: [{ type: 'text', text: response.content }] };
  } catch (err) {
    if (err instanceof BffRequestError && err.status === 404) {
      return notFoundResult(`document_not_found: ${docLabel(feature_id, kind, resolved.path)}`);
    }
    return formatBffError(err);
  }
}

// ── create_storage_document / update_storage_document ────────────────────────

/** Response shape from storage-service's `toDocResponse` (POST /api/documents/import). */
export interface StorageDocResponse {
  id: string;
  workspace_id: string;
  feature_id?: string;
  path: string;
  current_version_id?: string;
  created_at: string;
  deleted_at?: string;
}

/** Response shape from storage-service's `toVersionResponse`. */
export interface StorageDocVersionResponse {
  id: string;
  document_id: string;
  snapshot_ref: string;
  parent_version_id?: string;
  author: string;
  source: string;
  created_at: string;
  label?: string;
}

export interface ImportDocumentResponse {
  document: StorageDocResponse;
  version: StorageDocVersionResponse;
}

export interface PutDocumentContentResponse {
  ok: boolean;
  version_id: string;
}

/**
 * Creates a document with initial content via storage-service's
 * `POST /api/documents/import` — a single call that both provisions the document row
 * and seeds its first version, unlike the plain POST /api/documents (used internally
 * by workflow-backend at feature-creation time), which creates an empty row with no
 * version. feature_id omitted creates it at the workspace root, with no owning
 * feature (e.g. a shared file uploaded outside any feature's folder).
 *
 * This is create-or-get, NOT upsert: if a document at this path already exists,
 * storage-service deliberately returns the EXISTING document/version unchanged
 * rather than overwriting it (see storage-service's importMarkdownAlreadyExists) —
 * a real edit may have landed on it since, and blindly re-importing would clobber
 * that. Use update_storage_document to modify an existing document's content.
 */
export async function handleCreateStorageDocument(
  args: { workspace_id: string; feature_id?: string; kind?: DocumentKind; path?: string; content: string },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, feature_id, kind, path, content } = args;
  const resolved = resolveDocPath(feature_id, kind, path);
  if ('error' in resolved) return resolved.error;
  try {
    const response = await bffClient.post<ImportDocumentResponse>('/bff/storage-service/api/documents/import', {
      workspace_id,
      feature_id: feature_id ?? '',
      path: resolved.path,
      content,
    });
    return jsonResult({
      id: response.document.id,
      path: response.document.path,
      version_id: response.version.id,
    });
  } catch (err) {
    return formatBffError(err);
  }
}

/**
 * Updates an existing document's content via storage-service's
 * `PUT .../documents/content?path=...` — creates a new version and makes it current.
 * feature_id omitted targets a workspace-root document (no owning feature).
 *
 * Edit-only: 404s ("document not found") if no document at this path exists yet —
 * call create_storage_document first.
 */
export async function handleUpdateStorageDocument(
  args: { workspace_id: string; feature_id?: string; kind?: DocumentKind; path?: string; content: string },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, feature_id, kind, path, content } = args;
  const resolved = resolveDocPath(feature_id, kind, path);
  if ('error' in resolved) return resolved.error;
  try {
    const response = await bffClient.put<PutDocumentContentResponse>(
      documentContentUrl(workspace_id, feature_id, resolved.path),
      { content },
    );
    return jsonResult(response);
  } catch (err) {
    if (err instanceof BffRequestError && err.status === 404) {
      return notFoundResult(
        `document_not_found: ${docLabel(feature_id, kind, resolved.path)} — call create_storage_document first`,
      );
    }
    return formatBffError(err);
  }
}

// ── list_workspace_documents ──────────────────────────────────────────────────

export async function handleListWorkspaceDocuments(
  args: { workspace_id: string; feature_id?: string; limit?: number },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, feature_id, limit } = args;
  const base = feature_id
    ? `/bff/storage-service/api/workspaces/${encodeURIComponent(workspace_id)}/features/${encodeURIComponent(feature_id)}/documents`
    : `/bff/storage-service/api/workspaces/${encodeURIComponent(workspace_id)}/documents`;
  const qs = limit !== undefined ? `?limit=${encodeURIComponent(limit)}` : '';

  try {
    const response = await bffClient.get<{ documents: unknown[]; truncated?: boolean }>(
      `${base}${qs}`,
    );
    return jsonResult({ documents: response.documents, truncated: !!response.truncated });
  } catch (err) {
    return formatBffError(err);
  }
}

// ── get_document_versions ────────────────────────────────────────────────────

export async function handleGetDocumentVersions(
  args: { document_id: string; limit?: number },
  bffClient: BffClient,
): Promise<ToolResult> {
  const qs = args.limit !== undefined ? `?limit=${encodeURIComponent(args.limit)}` : '';
  try {
    const response = await bffClient.get<{ versions: unknown[]; truncated?: boolean }>(
      `/bff/storage-service/api/documents/${encodeURIComponent(args.document_id)}/versions${qs}`,
    );
    return jsonResult({ versions: response.versions, truncated: !!response.truncated });
  } catch (err) {
    if (err instanceof BffRequestError && err.status === 404) {
      return notFoundResult(`document_not_found: "${args.document_id}"`);
    }
    return formatBffError(err);
  }
}

// ── whoami ────────────────────────────────────────────────────────────────────

export async function handleWhoami(bffClient: BffClient): Promise<ToolResult> {
  try {
    const response = await bffClient.get<{ success: boolean; data: unknown }>(
      '/bff/user-service/api/me',
    );
    return jsonResult(response.data);
  } catch (err) {
    return formatBffError(err);
  }
}

// ── workspace_id / org_id resolution ──────────────────────────────────────────

const WORKSPACE_ID_DESCRIPTION =
  'Workspace UUID. Optional when running under the Actorium VS Code extension — the ' +
  "connected workspace's UUID is used automatically. Pass it explicitly to target a " +
  'different workspace, or when no extension is connected.';

const ORG_ID_DESCRIPTION =
  'Organization UUID. Optional when running under the Actorium VS Code extension — the ' +
  "connected org's UUID is used automatically. Pass it explicitly to target a different " +
  'organization, or when no extension is connected.';

export function missingWorkspaceIdError(): ToolResult {
  return notFoundResult(
    'workspace_id was not provided and no default workspace is configured. Pass workspace_id ' +
      'explicitly, or connect a workspace via the Actorium VS Code extension.',
  );
}

function missingOrgIdError(): ToolResult {
  return notFoundResult(
    'org_id was not provided and no default organization is configured. Pass org_id explicitly, ' +
      'or connect an organization via the Actorium VS Code extension.',
  );
}

/** Resolves the caller-supplied workspace_id against the configured default
 * (from the shared credential file — see authFile.ts), returning a ready-to-
 * return error ToolResult when neither is available. */
export function resolveWorkspaceId(
  provided: string | undefined,
  defaultWorkspaceId: string | undefined,
): { workspaceId: string } | { error: ToolResult } {
  const workspaceId = provided ?? defaultWorkspaceId;
  if (!workspaceId) return { error: missingWorkspaceIdError() };
  return { workspaceId };
}

/** Same pattern as resolveWorkspaceId, for tools scoped by org instead
 * (currently just list_workspaces). */
export function resolveOrgId(
  provided: string | undefined,
  defaultOrgId: string | undefined,
): { orgId: string } | { error: ToolResult } {
  const orgId = provided ?? defaultOrgId;
  if (!orgId) return { error: missingOrgIdError() };
  return { orgId };
}

/** Applied via registerTool's config object (the current, non-deprecated
 * replacement for the old positional `server.tool(name, description, schema,
 * cb)` overloads) to every tool below with no side effects on an external
 * system. create_storage_document/update_storage_document are the
 * exceptions — they get readOnlyHint: false instead (see their own
 * registerTool calls). */
const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true };

export function registerTools(
  server: McpServer,
  bffClient: BffClient,
  defaultWorkspaceId?: string,
  defaultOrgId?: string,
): void {
  server.registerTool(
    'get_feature',
    {
      description:
        'Get a workflow feature by name (slug). Returns the full feature detail — status/stage, ' +
        'documents, tasks, activity timeline, and sync state all in one call. The embedded ' +
        'activity timeline is capped at the 50 most recent events — use list_workspace_activity ' +
        'for the full history.',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        name: z.string().describe('Feature name (slug), e.g. "executor-self-briefing"'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleGetFeature({ ...args, workspace_id: resolved.workspaceId }, bffClient);
    },
  );

  server.registerTool(
    'list_workspaces',
    {
      description: 'List every workspace in an organization.',
      inputSchema: {
        org_id: z.string().optional().describe(ORG_ID_DESCRIPTION),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveOrgId(args.org_id, defaultOrgId);
      if ('error' in resolved) return resolved.error;
      return handleListWorkspaces({ org_id: resolved.orgId }, bffClient);
    },
  );

  server.registerTool(
    'search_features',
    {
      description:
        'Search/list features in a workspace, optionally filtered by status/title. Set ' +
        'include_tasks to embed each feature\'s task list (avoids N+1 get_task calls).',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        status: z.string().optional().describe('Filter by feature status'),
        title: z.string().optional().describe('Filter by title substring'),
        sort: z.string().optional().describe('Sort order (server-defined field names)'),
        page: z.number().optional().describe('Page number (1-indexed)'),
        limit: z.number().optional().describe('Page size'),
        include_tasks: z.boolean().optional().describe("Embed each feature's tasks in the response"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleSearchFeatures({ ...args, workspace_id: resolved.workspaceId }, bffClient);
    },
  );

  server.registerTool(
    'search_tasks',
    {
      description: 'Search/list tasks — across the whole workspace, or scoped to one feature via feature_id.',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        feature_id: z.string().optional().describe('Restrict to one feature (omit for workspace-wide)'),
        task_id: z.string().optional().describe('Filter by task name/id'),
        title: z.string().optional().describe('Filter by title substring'),
        status: z.string().optional().describe('Filter by task status'),
        repo: z.string().optional().describe('Filter by target repo id'),
        sort: z.string().optional().describe('Sort order (server-defined field names)'),
        page: z.number().optional().describe('Page number (1-indexed)'),
        limit: z.number().optional().describe('Page size'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleSearchTasks({ ...args, workspace_id: resolved.workspaceId }, bffClient);
    },
  );

  server.registerTool(
    'get_task',
    {
      description:
        'Get full task detail: execution info, both PR refs (implementation + workspace/handoff), ' +
        'per-task activity timeline (capped at the 50 most recent events), and dependency names.',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        task_id: z.string().describe('Task UUID (from search_tasks/get_feature)'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleGetTask({ ...args, workspace_id: resolved.workspaceId }, bffClient);
    },
  );

  server.registerTool(
    'get_task_diff',
    {
      description:
        "Get a task's PR file list + unified diff (GitHub-backed). Empty (not an error) if the " +
        'task has no PR yet. Large diffs are size-capped server-side (file count, per-file patch, ' +
        'and the unified diff itself) with `truncated: true` set when a cap was hit — pass ' +
        'files_only=true to skip the diff/patch content entirely and just get filenames + stats.',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        task_id: z.string().describe('Task UUID'),
        repo: z
          .string()
          .optional()
          .describe('Which of the task\'s repos to diff (defaults to the implementation PR)'),
        files_only: z
          .boolean()
          .optional()
          .describe(
            'Skip fetching/returning the unified diff and per-file patches — just filenames + ' +
              'add/delete stats. Use when you only need to know what changed, not the actual diff.',
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleGetTaskDiff({ ...args, workspace_id: resolved.workspaceId }, bffClient);
    },
  );

  server.registerTool(
    'get_task_review_thread',
    {
      description:
        "Get a task's PR review thread — reviews, review comments, and issue comments merged into " +
        'one chronological feed (GitHub-backed). Capped at the 200 most recent items with each ' +
        'item\'s body capped at 5000 bytes — `truncated: true` is set when a cap was hit.',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        task_id: z.string().describe('Task UUID'),
        repo: z
          .string()
          .optional()
          .describe('Which of the task\'s repos to read (defaults to the implementation PR)'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleGetTaskReviewThread({ ...args, workspace_id: resolved.workspaceId }, bffClient);
    },
  );

  server.registerTool(
    'get_feature_handoff',
    {
      description:
        'Get a go-owned feature\'s handoff state — the multi-repo final-PR fan-out as it nears ' +
        'completion. 404 if the feature isn\'t go-owned or has no handoff yet.',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        feature_id: z.string().describe('Feature UUID'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleGetFeatureHandoff({ ...args, workspace_id: resolved.workspaceId }, bffClient);
    },
  );

  server.registerTool(
    'list_workspace_activity',
    {
      description:
        'Get the audit/activity feed for a workspace, optionally filtered to one feature or task. ' +
        'audience=client filters to a curated, human-friendly action set; omit for the full ' +
        'internal feed. Paginated (page/limit) — defaults to the 50 most recent events, max 1000 ' +
        'per page.',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        feature_id: z.string().optional().describe('Restrict to one feature'),
        task_id: z.string().optional().describe('Restrict to one task'),
        audience: z.enum(['internal', 'client']).optional().describe('Filter action verbosity'),
        page: z.number().optional().describe('Page number (1-indexed, default 1)'),
        limit: z.number().optional().describe('Page size (default 50, max 1000)'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleListWorkspaceActivity({ ...args, workspace_id: resolved.workspaceId }, bffClient);
    },
  );

  server.registerTool(
    'list_workspace_repos',
    {
      description:
        'List every repo registered in a workspace — id, url, default branch, whether it\'s the ' +
        'management repo, and its tags.',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleListWorkspaceRepos({ workspace_id: resolved.workspaceId }, bffClient);
    },
  );

  const FEATURE_ID_OPTIONAL_DESCRIPTION =
    'Feature UUID. Omit for a workspace-root document with no owning feature (e.g. a shared ' +
    "file uploaded outside any feature's folder) — path is then relative to the workspace " +
    'root instead of a feature folder.';
  const KIND_DESCRIPTION =
    'Canonical per-feature document kind. Mutually exclusive with path, and requires feature_id ' +
    '(these four are always feature-scoped).';
  const PATH_DESCRIPTION =
    'Explicit relative document path (e.g. "notes/design.md") for anything other than the four ' +
    'canonical kinds — including a workspace-root document (feature_id omitted). Mutually ' +
    'exclusive with kind. Pass exactly one of kind or path.';
  const STORAGE_DOC_KIND_ENUM = z.enum(['product_spec', 'technical_design', 'tasks', 'handoff']);

  server.registerTool(
    'read_storage_document',
    {
      description:
        "Read a document's content from storage-service — a go-owned feature's canonical doc (via " +
        'kind) or any other document, including a workspace-root file with no owning feature (via ' +
        'path). Scoped to storage-service-backed documents only — a go-owned feature\'s ts-owned ' +
        'siblings remain git-backed.',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        feature_id: z.string().optional().describe(FEATURE_ID_OPTIONAL_DESCRIPTION),
        kind: STORAGE_DOC_KIND_ENUM.optional().describe(KIND_DESCRIPTION),
        path: z.string().optional().describe(PATH_DESCRIPTION),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleReadStorageDocument(
        { ...args, workspace_id: resolved.workspaceId } as {
          workspace_id: string;
          feature_id?: string;
          kind?: DocumentKind;
          path?: string;
        },
        bffClient,
      );
    },
  );

  server.registerTool(
    'create_storage_document',
    {
      description:
        'Create a document in storage-service, seeding its initial content in one call — a go-owned ' +
        'feature\'s canonical doc (via kind) or any other document, including a workspace-root file ' +
        'with no owning feature (via path, feature_id omitted). Create-or-get, not upsert: if a ' +
        'document at this path already exists, the EXISTING document is returned UNCHANGED — this ' +
        'never overwrites existing content. Use update_storage_document to modify a document that ' +
        'already exists.',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        feature_id: z.string().optional().describe(FEATURE_ID_OPTIONAL_DESCRIPTION),
        kind: STORAGE_DOC_KIND_ENUM.optional().describe(KIND_DESCRIPTION),
        path: z.string().optional().describe(PATH_DESCRIPTION),
        content: z.string().describe('Initial markdown content'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleCreateStorageDocument(
        { ...args, workspace_id: resolved.workspaceId } as {
          workspace_id: string;
          feature_id?: string;
          kind?: DocumentKind;
          path?: string;
          content: string;
        },
        bffClient,
      );
    },
  );

  server.registerTool(
    'update_storage_document',
    {
      description:
        "Update an existing document's content in storage-service, creating a new version — a " +
        'go-owned feature\'s canonical doc (via kind) or any other document, including a ' +
        'workspace-root file with no owning feature (via path, feature_id omitted). Edit-only — ' +
        '404s with document_not_found if no document at this path exists yet; call ' +
        'create_storage_document first.',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        feature_id: z.string().optional().describe(FEATURE_ID_OPTIONAL_DESCRIPTION),
        kind: STORAGE_DOC_KIND_ENUM.optional().describe(KIND_DESCRIPTION),
        path: z.string().optional().describe(PATH_DESCRIPTION),
        content: z.string().describe('New markdown content, replacing the current version'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleUpdateStorageDocument(
        { ...args, workspace_id: resolved.workspaceId } as {
          workspace_id: string;
          feature_id?: string;
          kind?: DocumentKind;
          path?: string;
          content: string;
        },
        bffClient,
      );
    },
  );

  server.registerTool(
    'list_workspace_documents',
    {
      description:
        'List every document\'s metadata (id, path, created_at, current_version_id) in a workspace, ' +
        'or in one feature via feature_id. Does not include content — use read_storage_document ' +
        'for that. Defaults to at most 500 documents per call (max 2000) — response includes ' +
        '`truncated: true` if the cap was hit.',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        feature_id: z.string().optional().describe('Restrict to one feature (omit for workspace-wide)'),
        limit: z.number().optional().describe('Max documents to return (default 500, max 2000)'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleListWorkspaceDocuments({ ...args, workspace_id: resolved.workspaceId }, bffClient);
    },
  );

  server.registerTool(
    'get_document_versions',
    {
      description:
        "Get a document's edit history (newest first) — source (edit/import/migration/restore) and " +
        'timestamp per version. Note: author is a raw user UUID, not a resolved display name. ' +
        'Defaults to at most 200 versions per call (max 1000) — response includes `truncated: ' +
        'true` if the cap was hit.',
      inputSchema: {
        document_id: z.string().describe('Document UUID (from list_workspace_documents)'),
        limit: z.number().optional().describe('Max versions to return (default 200, max 1000)'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => handleGetDocumentVersions(args, bffClient),
  );

  server.registerTool(
    'whoami',
    {
      description:
        'Get the authenticated caller\'s identity — profile, org memberships, and platform roles. ' +
        'Useful for sanity-checking auth/org scope before calling workspace-scoped tools.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    () => handleWhoami(bffClient),
  );
}
