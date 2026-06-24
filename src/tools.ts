import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BffClient, BffRequestError } from './bffClient.js';

export interface Feature {
  id: string;
  feature_id: string;
  feature_name: string;
  title: string;
  feature_status: string;
  current_stage: string;
  owner?: string;
}

export interface FeaturesResponse {
  features: Feature[];
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
      `/api/workspaces/${encodeURIComponent(workspace_id)}/features?name=${encodeURIComponent(name)}`,
    );
  } catch (err) {
    return formatBffError(err);
  }

  const features = response.features ?? [];
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
      `/api/workspaces/${encodeURIComponent(workspace_id)}/features/${encodeURIComponent(feature_id)}/tasks`,
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
}
