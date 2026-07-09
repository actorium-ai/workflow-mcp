import { BffClient, BffAuthError, BffRequestError } from './bffClient';
import {
  handleGetFeature,
  handleCreateTasks,
  handleUnblockTask,
  handleReadStorageDocument,
  handleWriteStorageDocument,
  Feature,
  FeaturesResponse,
  CreateTasksResponse,
  TaskFailure,
  TaskInput,
  Task,
  TasksResponse,
  UnblockResponse,
  DocumentContentResponse,
  ImportDocumentResponse,
  DocumentKind,
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
    status: 'in_implementation',
    current_stage: 'tasks',
  };

  it('returns the feature JSON when found', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: { items: [feature], total: 1, page: 1, limit: 0 } } as FeaturesResponse);

    const result = await handleGetFeature({ workspace_id: 'ws-1', name: 'my-feature' }, client);

    expect(result?.isError).toBeFalsy();
    expect(firstText(result)).toContain('my-feature');
    expect(firstText(result)).toContain('uuid-1');
  });

  it('calls the correct BFF endpoint', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: { items: [feature], total: 1, page: 1, limit: 0 } } as FeaturesResponse);

    await handleGetFeature({ workspace_id: 'ws-1', name: 'my-feature' }, client);

    expect(client.get).toHaveBeenCalledWith('/bff/workflow-backend/api/workspaces/ws-1/features?name=my-feature');
  });

  it('encodes special characters in workspace_id and name', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: { items: [feature], total: 1, page: 1, limit: 0 } } as FeaturesResponse);

    await handleGetFeature({ workspace_id: 'ws/1', name: 'my feature' }, client);

    expect(client.get).toHaveBeenCalledWith('/bff/workflow-backend/api/workspaces/ws%2F1/features?name=my%20feature');
  });

  it('returns not-found message when features array is empty', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: { items: [], total: 0, page: 1, limit: 0 } } as FeaturesResponse);

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

    expect(client.post).toHaveBeenCalledWith('/bff/workflow-backend/api/workspaces/ws-1/features/feat-uuid-1/tasks', { tasks });
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

describe('handleUnblockTask', () => {
  const FEAT_UUID = '550e8400-e29b-41d4-a716-446655440000';
  const TASK_UUID = '660e8400-e29b-41d4-a716-446655440001';

  const feature: Feature = {
    id: FEAT_UUID,
    feature_id: 'my-feature',
    feature_name: 'my-feature',
    title: 'My Feature',
    status: 'in_implementation',
    current_stage: 'tasks',
  };

  const task: Task = {
    task_id: TASK_UUID,
    task_name: 'T3',
    title: 'Task Three',
    status: 'blocked',
  };

  function makeFeatureResponse(items: Feature[]): FeaturesResponse {
    return { success: true, data: { items, total: items.length, page: 1, limit: 10 } };
  }

  function makeTasksResponse(items: Task[]): TasksResponse {
    return { success: true, data: { items, total: items.length, page: 1, limit: 10 } };
  }

  it('resolves feature name and task name then calls unblock endpoint', async () => {
    const client = makeClient();
    client.get = jest.fn()
      .mockResolvedValueOnce(makeFeatureResponse([feature]))
      .mockResolvedValueOnce(makeTasksResponse([task]));
    const unblockResp: UnblockResponse = { task_id: TASK_UUID, from: 'blocked', to: 'ready' };
    client.post = jest.fn().mockResolvedValueOnce(unblockResp);

    const result = await handleUnblockTask({ workspace_id: 'ws-1', feature: 'my-feature', task: 'T3' }, client);

    expect(result?.isError).toBeFalsy();
    const body = JSON.parse(firstText(result));
    expect(body).toEqual({ ok: true, from: 'blocked', to: 'ready' });
  });

  it('skips feature resolution when feature is already a UUID', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce(makeTasksResponse([task]));
    const unblockResp: UnblockResponse = { task_id: TASK_UUID, from: 'blocked', to: 'ready' };
    client.post = jest.fn().mockResolvedValueOnce(unblockResp);

    const result = await handleUnblockTask({ workspace_id: 'ws-1', feature: FEAT_UUID, task: 'T3' }, client);

    expect(result?.isError).toBeFalsy();
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('/tasks?name=T3'));
  });

  it('skips task resolution when task is already a UUID', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce(makeFeatureResponse([feature]));
    const unblockResp: UnblockResponse = { task_id: TASK_UUID, from: 'blocked', to: 'in_review' };
    client.post = jest.fn().mockResolvedValueOnce(unblockResp);

    const result = await handleUnblockTask({ workspace_id: 'ws-1', feature: 'my-feature', task: TASK_UUID }, client);

    expect(result?.isError).toBeFalsy();
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith(expect.stringContaining(TASK_UUID), expect.anything());
  });

  it('skips both resolutions when both are UUIDs', async () => {
    const client = makeClient();
    const unblockResp: UnblockResponse = { task_id: TASK_UUID, from: 'blocked', to: 'ready' };
    client.post = jest.fn().mockResolvedValueOnce(unblockResp);

    const result = await handleUnblockTask({ workspace_id: 'ws-1', feature: FEAT_UUID, task: TASK_UUID }, client);

    expect(result?.isError).toBeFalsy();
    expect(client.get).not.toHaveBeenCalled();
  });

  it('calls the correct unblock endpoint URL', async () => {
    const client = makeClient();
    client.get = jest.fn()
      .mockResolvedValueOnce(makeFeatureResponse([feature]))
      .mockResolvedValueOnce(makeTasksResponse([task]));
    const unblockResp: UnblockResponse = { task_id: TASK_UUID, from: 'blocked', to: 'ready' };
    client.post = jest.fn().mockResolvedValueOnce(unblockResp);

    await handleUnblockTask({ workspace_id: 'ws-1', feature: 'my-feature', task: 'T3' }, client);

    expect(client.post).toHaveBeenCalledWith(
      `/bff/workflow-backend/api/workspaces/ws-1/features/${FEAT_UUID}/tasks/${TASK_UUID}/unblock`,
      {},
    );
  });

  it('passes note in the request body when provided', async () => {
    const client = makeClient();
    client.get = jest.fn()
      .mockResolvedValueOnce(makeFeatureResponse([feature]))
      .mockResolvedValueOnce(makeTasksResponse([task]));
    const unblockResp: UnblockResponse = { task_id: TASK_UUID, from: 'blocked', to: 'ready' };
    client.post = jest.fn().mockResolvedValueOnce(unblockResp);

    await handleUnblockTask({ workspace_id: 'ws-1', feature: 'my-feature', task: 'T3', note: 'fixed the thing' }, client);

    expect(client.post).toHaveBeenCalledWith(expect.any(String), { note: 'fixed the thing' });
  });

  it('encodes special characters in workspace_id and UUIDs', async () => {
    const client = makeClient();
    client.get = jest.fn()
      .mockResolvedValueOnce(makeFeatureResponse([feature]))
      .mockResolvedValueOnce(makeTasksResponse([task]));
    const unblockResp: UnblockResponse = { task_id: TASK_UUID, from: 'blocked', to: 'ready' };
    client.post = jest.fn().mockResolvedValueOnce(unblockResp);

    await handleUnblockTask({ workspace_id: 'ws/1', feature: 'my feature', task: 'T3' }, client);

    expect(client.get).toHaveBeenNthCalledWith(1, expect.stringContaining('ws%2F1'));
    expect(client.get).toHaveBeenNthCalledWith(1, expect.stringContaining('my%20feature'));
  });

  it('returns feature_not_found when feature name resolves to empty list', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce(makeFeatureResponse([]));

    const result = await handleUnblockTask({ workspace_id: 'ws-1', feature: 'missing-feat', task: 'T3' }, client);

    expect(result?.isError).toBe(true);
    const body = JSON.parse(firstText(result));
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/feature_not_found/);
    expect(body.reason).toContain('missing-feat');
  });

  it('returns task_not_found when task name resolves to empty list', async () => {
    const client = makeClient();
    client.get = jest.fn()
      .mockResolvedValueOnce(makeFeatureResponse([feature]))
      .mockResolvedValueOnce(makeTasksResponse([]));

    const result = await handleUnblockTask({ workspace_id: 'ws-1', feature: 'my-feature', task: 'T99' }, client);

    expect(result?.isError).toBe(true);
    const body = JSON.parse(firstText(result));
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/task_not_found/);
    expect(body.reason).toContain('T99');
  });

  it('returns task_not_blocked on 409 from unblock endpoint', async () => {
    const client = makeClient();
    client.get = jest.fn()
      .mockResolvedValueOnce(makeFeatureResponse([feature]))
      .mockResolvedValueOnce(makeTasksResponse([task]));
    client.post = jest.fn().mockRejectedValueOnce(
      new BffRequestError('BFF request failed: 409 Conflict', 409, {}),
    );

    const result = await handleUnblockTask({ workspace_id: 'ws-1', feature: 'my-feature', task: 'T3' }, client);

    expect(result?.isError).toBe(true);
    const body = JSON.parse(firstText(result));
    expect(body).toEqual({ ok: false, reason: 'task_not_blocked' });
  });

  it('returns task_not_found on 404 from unblock endpoint', async () => {
    const client = makeClient();
    client.get = jest.fn()
      .mockResolvedValueOnce(makeFeatureResponse([feature]))
      .mockResolvedValueOnce(makeTasksResponse([task]));
    client.post = jest.fn().mockRejectedValueOnce(
      new BffRequestError('BFF request failed: 404 Not Found', 404, {}),
    );

    const result = await handleUnblockTask({ workspace_id: 'ws-1', feature: 'my-feature', task: 'T3' }, client);

    expect(result?.isError).toBe(true);
    const body = JSON.parse(firstText(result));
    expect(body).toEqual({ ok: false, reason: 'task_not_found' });
  });

  it('returns access_denied on 403 from unblock endpoint', async () => {
    const client = makeClient();
    client.get = jest.fn()
      .mockResolvedValueOnce(makeFeatureResponse([feature]))
      .mockResolvedValueOnce(makeTasksResponse([task]));
    client.post = jest.fn().mockRejectedValueOnce(
      new BffRequestError('BFF request failed: 403 Forbidden', 403, {}),
    );

    const result = await handleUnblockTask({ workspace_id: 'ws-1', feature: 'my-feature', task: 'T3' }, client);

    expect(result?.isError).toBe(true);
    const body = JSON.parse(firstText(result));
    expect(body).toEqual({ ok: false, reason: 'access_denied' });
  });

  it('returns auth error on BffAuthError during feature resolution', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(
      new BffAuthError('Authentication failed (401). Please log in again and update WORKFLOW_SESSION_COOKIE'),
    );

    const result = await handleUnblockTask({ workspace_id: 'ws-1', feature: 'my-feature', task: 'T3' }, client);

    expect(result?.isError).toBe(true);
    expect(firstText(result)).toContain('Authentication failed');
  });

  it('returns auth error on BffAuthError during unblock call', async () => {
    const client = makeClient();
    client.get = jest.fn()
      .mockResolvedValueOnce(makeFeatureResponse([feature]))
      .mockResolvedValueOnce(makeTasksResponse([task]));
    client.post = jest.fn().mockRejectedValueOnce(
      new BffAuthError('Authentication failed (401). Please log in again and update WORKFLOW_SESSION_COOKIE'),
    );

    const result = await handleUnblockTask({ workspace_id: 'ws-1', feature: 'my-feature', task: 'T3' }, client);

    expect(result?.isError).toBe(true);
    expect(firstText(result)).toContain('Authentication failed');
  });

  it('returns generic error on unexpected 500 from unblock endpoint', async () => {
    const client = makeClient();
    client.get = jest.fn()
      .mockResolvedValueOnce(makeFeatureResponse([feature]))
      .mockResolvedValueOnce(makeTasksResponse([task]));
    client.post = jest.fn().mockRejectedValueOnce(
      new BffRequestError('BFF request failed: 500 Internal Server Error', 500, undefined),
    );

    const result = await handleUnblockTask({ workspace_id: 'ws-1', feature: 'my-feature', task: 'T3' }, client);

    expect(result?.isError).toBe(true);
    expect(firstText(result)).toContain('500');
  });
});

describe('handleReadStorageDocument', () => {
  const WS = 'ws-uuid-1';
  const FID = 'feat-uuid-1';
  const KIND: DocumentKind = 'product_spec';

  it('returns document content on success', async () => {
    const client = makeClient();
    const resp: DocumentContentResponse = { content: '# Product Spec\nHello' };
    client.get = jest.fn().mockResolvedValueOnce(resp);

    const result = await handleReadStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND }, client);

    expect(result?.isError).toBeFalsy();
    expect(firstText(result)).toBe('# Product Spec\nHello');
  });

  it('calls the correct storage-service endpoint', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ content: '' } as DocumentContentResponse);

    await handleReadStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND }, client);

    expect(client.get).toHaveBeenCalledWith(
      `/bff/storage-service/api/workspaces/${WS}/features/${FID}/documents/${KIND}/content`,
    );
  });

  it('encodes special characters in workspace_id and feature_id', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ content: '' } as DocumentContentResponse);

    await handleReadStorageDocument({ workspace_id: 'ws/1', feature_id: 'feat id', kind: KIND }, client);

    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('ws%2F1'));
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('feat%20id'));
  });

  it('returns document_not_found on 404', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(
      new BffRequestError('BFF request failed: 404 Not Found', 404, {}),
    );

    const result = await handleReadStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND }, client);

    expect(result?.isError).toBe(true);
    const body = JSON.parse(firstText(result));
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/document_not_found/);
    expect(body.reason).toContain(KIND);
  });

  it('returns auth error on BffAuthError', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(
      new BffAuthError('Authentication failed (401). Please log in again and update WORKFLOW_SESSION_COOKIE'),
    );

    const result = await handleReadStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND }, client);

    expect(result?.isError).toBe(true);
    expect(firstText(result)).toContain('Authentication failed');
  });

  it('returns error on unexpected 500', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(
      new BffRequestError('BFF request failed: 500 Internal Server Error', 500, undefined),
    );

    const result = await handleReadStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND }, client);

    expect(result?.isError).toBe(true);
    expect(firstText(result)).toContain('500');
  });
});

describe('handleWriteStorageDocument', () => {
  const WS = 'ws-uuid-1';
  const FID = 'feat-uuid-1';
  const KIND: DocumentKind = 'technical_design';
  const CONTENT = '# Technical Design\nContent here';

  it('returns ok with id/kind/slug on success', async () => {
    const client = makeClient();
    const resp: ImportDocumentResponse = { id: 'doc-uuid-1', kind: KIND, slug: 'technical-design' };
    client.post = jest.fn().mockResolvedValueOnce(resp);

    const result = await handleWriteStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND, content: CONTENT }, client);

    expect(result?.isError).toBeFalsy();
    const body = JSON.parse(firstText(result));
    expect(body).toEqual({ ok: true, id: 'doc-uuid-1', kind: KIND, slug: 'technical-design' });
  });

  it('calls the correct import endpoint with all required fields', async () => {
    const client = makeClient();
    client.post = jest.fn().mockResolvedValueOnce({ id: 'doc-uuid-1', kind: KIND, slug: 'technical-design' } as ImportDocumentResponse);

    await handleWriteStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND, content: CONTENT }, client);

    expect(client.post).toHaveBeenCalledWith('/bff/storage-service/api/documents/import', {
      workspace_id: WS,
      feature_id: FID,
      kind: KIND,
      content: CONTENT,
    });
  });

  it('returns auth error on BffAuthError', async () => {
    const client = makeClient();
    client.post = jest.fn().mockRejectedValueOnce(
      new BffAuthError('Authentication failed (401). Please log in again and update WORKFLOW_SESSION_COOKIE'),
    );

    const result = await handleWriteStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND, content: CONTENT }, client);

    expect(result?.isError).toBe(true);
    expect(firstText(result)).toContain('Authentication failed');
  });

  it('returns error on unexpected 500', async () => {
    const client = makeClient();
    client.post = jest.fn().mockRejectedValueOnce(
      new BffRequestError('BFF request failed: 500 Internal Server Error', 500, undefined),
    );

    const result = await handleWriteStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND, content: CONTENT }, client);

    expect(result?.isError).toBe(true);
    expect(firstText(result)).toContain('500');
  });

  it('returns error on 409 conflict', async () => {
    const client = makeClient();
    client.post = jest.fn().mockRejectedValueOnce(
      new BffRequestError('BFF request failed: 409 Conflict', 409, { error: 'document already exists' }),
    );

    const result = await handleWriteStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND, content: CONTENT }, client);

    expect(result?.isError).toBe(true);
    expect(firstText(result)).toContain('409');
  });
});
