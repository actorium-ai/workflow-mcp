import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BffClient, BffRequestError } from './bffClient.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

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

export interface TaskInput {
  name: string;
  title: string;
  repo: string;
  depends_on: string[];
  actor_type?: 'agent' | 'human' | 'either';
}

export interface CreatedTask {
  task_id: string;
  task_name: string;
  title: string;
  status: string;
}

export interface TaskFailure {
  name: string;
  reason: string;
}

export interface CreateTasksResponse {
  tasks: CreatedTask[];
}

export type ToolResult = CallToolResult;

function formatBffError(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

function extractFailures(body: unknown): TaskFailure[] | null {
  if (!body) return null;

  if (Array.isArray(body)) {
    if (body.length > 0 && typeof body[0] === 'object' && 'name' in body[0] && 'reason' in body[0]) {
      return body as TaskFailure[];
    }
  }

  if (typeof body === 'object' && body !== null) {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.failures)) return extractFailures(obj.failures);
    if (Array.isArray(obj.errors)) return extractFailures(obj.errors);
  }

  return null;
}

export async function handleGetFeature(
  args: { workspace_id: string; name: string },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, name } = args;
  let response: FeaturesResponse;
  try {
    response = await bffClient.get<FeaturesResponse>(
      `/bff/workflow-backend/api/workspaces/${encodeURIComponent(workspace_id)}/features?name=${encodeURIComponent(name)}`,
    );
  } catch (err) {
    return formatBffError(err);
  }

  const features = response.data?.items ?? [];
  if (features.length === 0) {
    return {
      content: [{ type: 'text', text: `Feature not found: "${name}" in workspace ${workspace_id}` }],
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(features[0], null, 2) }],
  };
}

export async function handleCreateTasks(
  args: { workspace_id: string; feature_id: string; tasks: TaskInput[] },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, feature_id, tasks } = args;
  try {
    const response = await bffClient.post<CreateTasksResponse>(
      `/bff/workflow-backend/api/workspaces/${encodeURIComponent(workspace_id)}/features/${encodeURIComponent(feature_id)}/tasks`,
      { tasks },
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(response.tasks ?? response, null, 2) }],
    };
  } catch (err) {
    if (err instanceof BffRequestError && (err.status === 409 || err.status === 422)) {
      const failures = extractFailures(err.body);
      if (failures) {
        const lines = failures.map((f) => `- ${f.name}: ${f.reason}`).join('\n');
        return {
          content: [{ type: 'text', text: `Task creation failed. The following tasks could not be created:\n\n${lines}` }],
          isError: true,
        };
      }
    }
    return formatBffError(err);
  }
}

export interface Task {
  task_id: string;
  task_name: string;
  title: string;
  status: string;
}

export interface TasksResponse {
  success: boolean;
  data: {
    items: Task[];
    total: number;
    page: number;
    limit: number;
  };
}

export interface UnblockResponse {
  task_id: string;
  from: string;
  to: string;
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
    return {
      error: {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: `feature_not_found: "${feature}" in workspace ${workspaceId}` }) }],
        isError: true,
      },
    };
  }
  return { featureUuid: features[0].id };
}

async function resolveTaskUuid(
  workspaceId: string,
  featureUuid: string,
  task: string,
  bffClient: BffClient,
): Promise<{ taskUuid: string } | { error: ToolResult }> {
  if (isUuid(task)) return { taskUuid: task };

  let response: TasksResponse;
  try {
    response = await bffClient.get<TasksResponse>(
      `/bff/workflow-backend/api/workspaces/${encodeURIComponent(workspaceId)}/features/${encodeURIComponent(featureUuid)}/tasks?name=${encodeURIComponent(task)}`,
    );
  } catch (err) {
    return { error: formatBffError(err) };
  }

  const tasks = response.data?.items ?? [];
  if (tasks.length === 0) {
    return {
      error: {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: `task_not_found: "${task}" in feature ${featureUuid}` }) }],
        isError: true,
      },
    };
  }
  return { taskUuid: tasks[0].task_id };
}

export async function handleUnblockTask(
  args: { workspace_id: string; feature: string; task: string; note?: string },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, feature, task, note } = args;

  const featureResult = await resolveFeatureUuid(workspace_id, feature, bffClient);
  if ('error' in featureResult) return featureResult.error;

  const taskResult = await resolveTaskUuid(workspace_id, featureResult.featureUuid, task, bffClient);
  if ('error' in taskResult) return taskResult.error;

  try {
    const body: Record<string, string> = note !== undefined ? { note } : {};
    const response = await bffClient.post<UnblockResponse>(
      `/bff/workflow-backend/api/workspaces/${encodeURIComponent(workspace_id)}/features/${encodeURIComponent(featureResult.featureUuid)}/tasks/${encodeURIComponent(taskResult.taskUuid)}/unblock`,
      body,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, from: response.from, to: response.to }) }],
    };
  } catch (err) {
    if (err instanceof BffRequestError) {
      if (err.status === 409) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'task_not_blocked' }) }],
          isError: true,
        };
      }
      if (err.status === 404) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'task_not_found' }) }],
          isError: true,
        };
      }
      if (err.status === 403) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'access_denied' }) }],
          isError: true,
        };
      }
    }
    return formatBffError(err);
  }
}

export type DocumentKind = 'product_spec' | 'technical_design' | 'tasks' | 'handoff';

export interface DocumentContentResponse {
  content: string;
}

export interface ImportDocumentResponse {
  id: string;
  kind: DocumentKind;
  slug: string;
}

export async function handleReadStorageDocument(
  args: { workspace_id: string; feature_id: string; kind: DocumentKind },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, feature_id, kind } = args;
  try {
    const response = await bffClient.get<DocumentContentResponse>(
      `/bff/storage-service/api/workspaces/${encodeURIComponent(workspace_id)}/features/${encodeURIComponent(feature_id)}/documents/${encodeURIComponent(kind)}/content`,
    );
    return {
      content: [{ type: 'text', text: response.content }],
    };
  } catch (err) {
    if (err instanceof BffRequestError && err.status === 404) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              reason: `document_not_found: kind="${kind}" in feature ${feature_id}`,
            }),
          },
        ],
        isError: true,
      };
    }
    return formatBffError(err);
  }
}

export async function handleWriteStorageDocument(
  args: { workspace_id: string; feature_id: string; kind: DocumentKind; content: string },
  bffClient: BffClient,
): Promise<ToolResult> {
  const { workspace_id, feature_id, kind, content } = args;
  try {
    const response = await bffClient.post<ImportDocumentResponse>(`/bff/storage-service/api/documents/import`, {
      workspace_id,
      feature_id,
      kind,
      content,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, id: response.id, kind: response.kind, slug: response.slug }) }],
    };
  } catch (err) {
    return formatBffError(err);
  }
}

export function registerTools(server: McpServer, bffClient: BffClient): void {
  server.tool(
    'get_feature',
    'Get a workflow feature by name (slug). Returns the feature including its UUID, or a not-found message.',
    {
      workspace_id: z.string().describe('Workspace UUID'),
      name: z.string().describe('Feature name (slug), e.g. "executor-self-briefing"'),
    },
    (args) => handleGetFeature(args, bffClient),
  );

  server.tool(
    'create_tasks',
    'Bulk-create tasks for a workflow feature (all-or-nothing). Returns created tasks on success, or the failure list [{name, reason}] if any task fails validation.',
    {
      workspace_id: z.string().describe('Workspace UUID'),
      feature_id: z.string().describe('Feature UUID (obtain via get_feature)'),
      tasks: z
        .array(
          z.object({
            name: z.string().describe('Task name, e.g. "T1"'),
            title: z.string().describe('Task title'),
            repo: z.string().describe('Target repository id'),
            depends_on: z.array(z.string()).describe('List of task names this task depends on'),
            actor_type: z
              .enum(['agent', 'human', 'either'])
              .optional()
              .describe('Execution actor type (defaults to agent)'),
          }),
        )
        .describe('Tasks to create (bulk, all-or-nothing)'),
    },
    (args) => handleCreateTasks(args, bffClient),
  );

  server.tool(
    'unblock_task',
    'Unblock a blocked workflow task. Resolves feature/task names to UUIDs, calls the unblock endpoint, and returns the server-derived resume state.',
    {
      workspace_id: z.string().describe('Workspace UUID'),
      feature: z.string().describe('Feature name (slug) or UUID, e.g. "executor-self-briefing"'),
      task: z.string().describe('Task name (e.g. "T3") or UUID'),
      note: z.string().optional().describe('Optional note explaining what was done to resolve the block'),
    },
    (args) => handleUnblockTask(args, bffClient),
  );

  server.tool(
    'read_storage_document',
    'Read a go-owned feature\'s document content from storage-service. Scoped to go-owned features only — ts-owned feature documents remain git-backed.',
    {
      workspace_id: z.string().describe('Workspace UUID'),
      feature_id: z.string().describe('Feature UUID'),
      kind: z
        .enum(['product_spec', 'technical_design', 'tasks', 'handoff'])
        .describe('Document kind to read'),
    },
    (args) => handleReadStorageDocument(args as { workspace_id: string; feature_id: string; kind: DocumentKind }, bffClient),
  );

  server.tool(
    'write_storage_document',
    'Create or import a markdown document into storage-service for a go-owned feature. Scoped to go-owned features only — ts-owned feature documents remain git-backed.',
    {
      workspace_id: z.string().describe('Workspace UUID'),
      feature_id: z.string().describe('Feature UUID'),
      kind: z
        .enum(['product_spec', 'technical_design', 'tasks', 'handoff'])
        .describe('Document kind to write'),
      content: z.string().describe('Markdown content to import'),
    },
    (args) => handleWriteStorageDocument(args as { workspace_id: string; feature_id: string; kind: DocumentKind; content: string }, bffClient),
  );
}
