import { BffClient, BffAuthError, BffRequestError } from './bffClient';
import {
  handleGetFeature,
  handleCreateTasks,
  Feature,
  FeaturesResponse,
  CreateTasksResponse,
  TaskFailure,
  TaskInput,
  ToolResult,
} from './tools';

jest.mock('./bffClient', () => {
  const actual = jest.requireActual('./bffClient') as typeof import('./bffClient');
  return {
    BffAuthError: actual.BffAuthError,
    BffRequestError: actual.BffRequestError,
    BffClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(),
      post: jest.fn(),
      request: jest.fn(),
    })),
  };
});

function makeClient(): jest.Mocked<BffClient> {
  return new (BffClient as jest.MockedClass<typeof BffClient>)('http://bff.example.com', 'sess') as jest.Mocked<BffClient>;
}

function firstText(result: ToolResult): string {
  const item = result.content[0];
  if (!item || item.type !== 'text') throw new Error('Expected text content');
  return item.text;
}

describe('handleGetFeature', () => {
  const feature: Feature = {
    id: 'uuid-1',
    feature_id: 'feat-uuid-1',
    feature_name: 'my-feature',
    title: 'My Feature',
    feature_status: 'in_implementation',
    current_stage: 'tasks',
  };

  it('returns the feature JSON when found', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ features: [feature] } as FeaturesResponse);

    const result = await handleGetFeature({ workspace_id: 'ws-1', name: 'my-feature' }, client);

    expect(result?.isError).toBeFalsy();
    expect(firstText(result)).toContain('my-feature');
    expect(firstText(result)).toContain('uuid-1');
  });

  it('calls the correct BFF endpoint', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ features: [feature] } as FeaturesResponse);

    await handleGetFeature({ workspace_id: 'ws-1', name: 'my-feature' }, client);

    expect(client.get).toHaveBeenCalledWith('/api/workspaces/ws-1/features?name=my-feature');
  });

  it('encodes special characters in workspace_id and name', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ features: [feature] } as FeaturesResponse);

    await handleGetFeature({ workspace_id: 'ws/1', name: 'my feature' }, client);

    expect(client.get).toHaveBeenCalledWith('/api/workspaces/ws%2F1/features?name=my%20feature');
  });

  it('returns not-found message when features array is empty', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ features: [] } as FeaturesResponse);

    const result = await handleGetFeature({ workspace_id: 'ws-1', name: 'missing' }, client);

    expect(result?.isError).toBeFalsy();
    expect(firstText(result)).toMatch(/not found/i);
    expect(firstText(result)).toContain('missing');
  });

  it('returns error with re-auth guidance on BffAuthError', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(
      new BffAuthError('Authentication failed (401). Please log in again and update WORKFLOW_SESSION_COOKIE'),
    );

    const result = await handleGetFeature({ workspace_id: 'ws-1', name: 'my-feature' }, client);

    expect(result?.isError).toBe(true);
    expect(firstText(result)).toContain('Authentication failed');
  });

  it('returns error on unexpected BFF failure', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(
      new BffRequestError('BFF request failed: 500 Internal Server Error', 500, undefined),
    );

    const result = await handleGetFeature({ workspace_id: 'ws-1', name: 'my-feature' }, client);

    expect(result?.isError).toBe(true);
    expect(firstText(result)).toContain('500');
  });
});

describe('handleCreateTasks', () => {
  const tasks: TaskInput[] = [
    { name: 'T1', title: 'Task One', repo: 'workflow-backend', depends_on: [] },
    { name: 'T2', title: 'Task Two', repo: 'workflow-backend', depends_on: ['T1'], actor_type: 'agent' },
  ];

  it('returns created tasks JSON on success', async () => {
    const client = makeClient();
    const response: CreateTasksResponse = {
      tasks: [
        { task_id: 'uuid-t1', task_name: 'T1', title: 'Task One', status: 'ready' },
        { task_id: 'uuid-t2', task_name: 'T2', title: 'Task Two', status: 'todo' },
      ],
    };
    client.post = jest.fn().mockResolvedValueOnce(response);

    const result = await handleCreateTasks({ workspace_id: 'ws-1', feature_id: 'feat-uuid-1', tasks }, client);

    expect(result?.isError).toBeFalsy();
    expect(firstText(result)).toContain('T1');
    expect(firstText(result)).toContain('uuid-t1');
  });

  it('calls the correct BFF endpoint with the tasks body', async () => {
    const client = makeClient();
    client.post = jest.fn().mockResolvedValueOnce({ tasks: [] } as CreateTasksResponse);

    await handleCreateTasks({ workspace_id: 'ws-1', feature_id: 'feat-uuid-1', tasks }, client);

    expect(client.post).toHaveBeenCalledWith('/api/workspaces/ws-1/features/feat-uuid-1/tasks', { tasks });
  });

  it('returns failure list on 422 with array body', async () => {
    const client = makeClient();
    const failures: TaskFailure[] = [{ name: 'T1', reason: 'task already exists' }];
    client.post = jest.fn().mockRejectedValueOnce(
      new BffRequestError('BFF request failed: 422 Unprocessable Entity', 422, failures),
    );

    const result = await handleCreateTasks({ workspace_id: 'ws-1', feature_id: 'feat-uuid-1', tasks }, client);

    expect(result?.isError).toBe(true);
    expect(firstText(result)).toContain('T1');
    expect(firstText(result)).toContain('task already exists');
  });

  it('returns failure list on 409 with failures-wrapped body', async () => {
    const client = makeClient();
    const failures: TaskFailure[] = [{ name: 'T2', reason: 'duplicate task name' }];
    client.post = jest.fn().mockRejectedValueOnce(
      new BffRequestError('BFF request failed: 409 Conflict', 409, { failures }),
    );

    const result = await handleCreateTasks({ workspace_id: 'ws-1', feature_id: 'feat-uuid-1', tasks }, client);

    expect(result?.isError).toBe(true);
    expect(firstText(result)).toContain('T2');
    expect(firstText(result)).toContain('duplicate task name');
  });

  it('returns auth error with re-auth guidance on BffAuthError', async () => {
    const client = makeClient();
    client.post = jest.fn().mockRejectedValueOnce(
      new BffAuthError('Authentication failed (401). Please log in again and update WORKFLOW_SESSION_COOKIE'),
    );

    const result = await handleCreateTasks({ workspace_id: 'ws-1', feature_id: 'feat-uuid-1', tasks }, client);

    expect(result?.isError).toBe(true);
    expect(firstText(result)).toContain('Authentication failed');
  });

  it('returns error on unexpected 500', async () => {
    const client = makeClient();
    client.post = jest.fn().mockRejectedValueOnce(
      new BffRequestError('BFF request failed: 500 Internal Server Error', 500, undefined),
    );

    const result = await handleCreateTasks({ workspace_id: 'ws-1', feature_id: 'feat-uuid-1', tasks }, client);

    expect(result?.isError).toBe(true);
    expect(firstText(result)).toContain('500');
  });
});
