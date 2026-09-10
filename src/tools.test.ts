import { BffClient, BffAuthError, BffRequestError } from './bffClient';
import {
  handleGetFeature,
  handleListWorkspaces,
  handleSearchFeatures,
  handleSearchTasks,
  handleGetTask,
  handleGetTaskDiff,
  handleGetTaskReviewThread,
  handleGetFeatureHandoff,
  handleListWorkspaceActivity,
  handleListWorkspaceRepos,
  handleReadStorageDocument,
  handleCreateStorageDocument,
  handleUpdateStorageDocument,
  handleListWorkspaceDocuments,
  handleGetDocumentVersions,
  handleWhoami,
  handleUpdateFeatureStage,
  resolveWorkspaceId,
  resolveOrgId,
  Feature,
  FeaturesResponse,
  FeatureDetailResponse,
  DocumentContentResponse,
  ImportDocumentResponse,
  PutDocumentContentResponse,
  DocumentKind,
  StageTransitionResponse,
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
      put: jest.fn(),
    })),
  };
});

function makeClient(): jest.Mocked<BffClient> {
  return new (BffClient as jest.MockedClass<typeof BffClient>)(() => ({
    bffUrl: 'http://bff.example.com',
    bearerToken: 'sess',
  })) as jest.Mocked<BffClient>;
}

function firstText(result: ToolResult): string {
  const item = result.content[0];
  if (!item || item.type !== 'text') throw new Error('Expected text content');
  return item.text;
}

const AUTH_ERROR = new BffAuthError(
  'Authentication failed (401). Your Actorium session has expired. ' +
    'Run "Actorium: Connect" in VS Code to reconnect, then retry.',
);
const SERVER_ERROR = new BffRequestError('BFF request failed: 500 Internal Server Error', 500, undefined);

describe('handleGetFeature', () => {
  const feature: Feature = {
    id: 'uuid-1',
    feature_id: 'feat-uuid-1',
    feature_name: 'my-feature',
    title: 'My Feature',
    status: 'in_implementation',
    current_stage: 'tasks',
  };
  const detail: FeatureDetailResponse = {
    success: true,
    data: {
      id: 'uuid-1',
      feature_name: 'my-feature',
      title: 'My Feature',
      status: 'in_implementation',
      current_stage: 'tasks',
      workspace_id: 'ws-1',
      tasks: [{ id: 't1' }],
      activity: [{ action: 'created' }],
      documents: [],
      source_state: { stale: false },
    },
  };

  function searchResponse(items: Feature[]): FeaturesResponse {
    return { success: true, data: { items, total: items.length, page: 1, limit: 10 } };
  }

  it('resolves the feature by name then calls the detail endpoint', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce(searchResponse([feature])).mockResolvedValueOnce(detail);

    const result = await handleGetFeature({ workspace_id: 'ws-1', name: 'my-feature' }, client);

    expect(result.isError).toBeFalsy();
    expect(client.get).toHaveBeenNthCalledWith(
      1,
      '/bff/workflow-backend/api/workspaces/ws-1/features?name=my-feature',
    );
    expect(client.get).toHaveBeenNthCalledWith(
      2,
      '/bff/workflow-backend/api/workspaces/ws-1/features/uuid-1',
    );
  });

  it('returns the bundled detail (tasks/activity/documents/source_state) in the response', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce(searchResponse([feature])).mockResolvedValueOnce(detail);

    const result = await handleGetFeature({ workspace_id: 'ws-1', name: 'my-feature' }, client);

    const body = JSON.parse(firstText(result));
    expect(body.tasks).toEqual([{ id: 't1' }]);
    expect(body.activity).toEqual([{ action: 'created' }]);
    expect(body.source_state).toEqual({ stale: false });
  });

  it('returns not-found message when the search returns no features', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce(searchResponse([]));

    const result = await handleGetFeature({ workspace_id: 'ws-1', name: 'missing' }, client);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/feature_not_found/i);
    expect(firstText(result)).toContain('missing');
  });

  it('returns error with re-auth guidance on BffAuthError', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(AUTH_ERROR);

    const result = await handleGetFeature({ workspace_id: 'ws-1', name: 'my-feature' }, client);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('Authentication failed');
  });

  // A BffAuthError only ever reaches a tool handler after BffClient's own
  // retry-on-401 already failed — this is the structured, actionable result
  // every one of the ~20 tools registered from tools.ts should give a calling
  // agent on that persistent failure, matching reviewTools.ts's session_expired
  // shape byte-for-byte (same reason/hint), not a differently-worded thrown
  // error message.
  it('gives a structured session_expired result (matching reviewTools.ts) on a persistent BffAuthError', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(AUTH_ERROR);

    const result = await handleGetFeature({ workspace_id: 'ws-1', name: 'my-feature' }, client);

    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result))).toMatchObject({
      ok: false,
      reason: 'session_expired',
      hint: 'Your login session is no longer valid. Log in again via the Actorium VS Code extension.',
    });
  });
});

describe('handleListWorkspaces', () => {
  it('calls the correct endpoint and relays the data array', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: [{ id: 'ws-1' }] });

    const result = await handleListWorkspaces({ org_id: 'org-1' }, client);

    expect(client.get).toHaveBeenCalledWith('/bff/workflow-backend/api/workspaces?org=org-1');
    expect(JSON.parse(firstText(result))).toEqual([{ id: 'ws-1' }]);
  });

  it('returns error on unexpected BFF failure', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(SERVER_ERROR);

    const result = await handleListWorkspaces({ org_id: 'org-1' }, client);
    expect(result.isError).toBe(true);
  });
});

describe('handleSearchFeatures', () => {
  it('builds the query string from provided filters', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: { items: [] } });

    await handleSearchFeatures(
      { workspace_id: 'ws-1', status: 'in_progress', include_tasks: true, page: 2, limit: 20 },
      client,
    );

    const [url] = (client.get as jest.Mock).mock.calls[0];
    expect(url).toContain('/workspaces/ws-1/features?');
    expect(url).toContain('status=in_progress');
    expect(url).toContain('include=tasks');
    expect(url).toContain('page=2');
    expect(url).toContain('limit=20');
  });

  it('omits the query string entirely when no filters are given', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: { items: [] } });

    await handleSearchFeatures({ workspace_id: 'ws-1' }, client);

    expect(client.get).toHaveBeenCalledWith('/bff/workflow-backend/api/workspaces/ws-1/features');
  });
});

describe('handleSearchTasks', () => {
  it('hits the feature-scoped route when feature_id is given', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: { items: [] } });

    await handleSearchTasks({ workspace_id: 'ws-1', feature_id: 'feat-1', status: 'blocked' }, client);

    expect(client.get).toHaveBeenCalledWith(
      '/bff/workflow-backend/api/workspaces/ws-1/features/feat-1/tasks?status=blocked',
    );
  });

  it('hits the workspace-wide route when feature_id is omitted', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: { items: [] } });

    await handleSearchTasks({ workspace_id: 'ws-1', repo: 'workflow-backend' }, client);

    expect(client.get).toHaveBeenCalledWith(
      '/bff/workflow-backend/api/workspaces/ws-1/tasks?repo=workflow-backend',
    );
  });
});

describe('handleGetTask', () => {
  it('calls the workspace-scoped task-detail endpoint', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: { id: 'task-1' } });

    const result = await handleGetTask({ workspace_id: 'ws-1', task_id: 'task-1' }, client);

    expect(client.get).toHaveBeenCalledWith('/bff/workflow-backend/api/workspaces/ws-1/tasks/task-1');
    expect(result.isError).toBeFalsy();
  });

  it('returns task_not_found on 404', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(new BffRequestError('404', 404, {}));

    const result = await handleGetTask({ workspace_id: 'ws-1', task_id: 'missing' }, client);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/task_not_found/);
  });
});

describe('handleGetTaskDiff / handleGetTaskReviewThread', () => {
  it('get_task_diff includes repo in the query string when given', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ files: [] });

    await handleGetTaskDiff({ workspace_id: 'ws-1', task_id: 'task-1', repo: 'backend' }, client);

    expect(client.get).toHaveBeenCalledWith(
      '/bff/workflow-backend/api/workspaces/ws-1/tasks/task-1/diff?repo=backend',
    );
  });

  it('get_task_diff omits the query string when repo is not given', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ files: [] });

    await handleGetTaskDiff({ workspace_id: 'ws-1', task_id: 'task-1' }, client);

    expect(client.get).toHaveBeenCalledWith(
      '/bff/workflow-backend/api/workspaces/ws-1/tasks/task-1/diff',
    );
  });

  it('get_task_diff appends files_only=true when requested', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ files: [] });

    await handleGetTaskDiff(
      { workspace_id: 'ws-1', task_id: 'task-1', files_only: true },
      client,
    );

    expect(client.get).toHaveBeenCalledWith(
      '/bff/workflow-backend/api/workspaces/ws-1/tasks/task-1/diff?files_only=true',
    );
  });

  it('get_task_diff combines repo and files_only in the query string', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ files: [] });

    await handleGetTaskDiff(
      { workspace_id: 'ws-1', task_id: 'task-1', repo: 'backend', files_only: true },
      client,
    );

    const [url] = (client.get as jest.Mock).mock.calls[0];
    expect(url).toContain('repo=backend');
    expect(url).toContain('files_only=true');
  });

  it('get_task_review_thread calls the review-thread endpoint', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ items: [] });

    await handleGetTaskReviewThread({ workspace_id: 'ws-1', task_id: 'task-1' }, client);

    expect(client.get).toHaveBeenCalledWith(
      '/bff/workflow-backend/api/workspaces/ws-1/tasks/task-1/review-thread',
    );
  });
});

describe('handleGetFeatureHandoff', () => {
  it('calls the handoff endpoint', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ created_at: '2026-01-01', prs: [] });

    await handleGetFeatureHandoff({ workspace_id: 'ws-1', feature_id: 'feat-1' }, client);

    expect(client.get).toHaveBeenCalledWith(
      '/bff/workflow-backend/api/workspaces/ws-1/features/feat-1/handoff',
    );
  });

  it('returns a handoff_not_found reason on 404', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(new BffRequestError('404', 404, {}));

    const result = await handleGetFeatureHandoff({ workspace_id: 'ws-1', feature_id: 'feat-1' }, client);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/handoff_not_found/);
  });
});

describe('handleListWorkspaceActivity', () => {
  it('builds the query string from feature_id/task_id/audience', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce([]);

    await handleListWorkspaceActivity(
      { workspace_id: 'ws-1', feature_id: 'feat-1', task_id: 'task-1', audience: 'client' },
      client,
    );

    const [url] = (client.get as jest.Mock).mock.calls[0];
    expect(url).toContain('featureId=feat-1');
    expect(url).toContain('taskId=task-1');
    expect(url).toContain('audience=client');
  });

  it('appends page/limit to the query string when given', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce([]);

    await handleListWorkspaceActivity({ workspace_id: 'ws-1', page: 2, limit: 25 }, client);

    const [url] = (client.get as jest.Mock).mock.calls[0];
    expect(url).toContain('page=2');
    expect(url).toContain('limit=25');
  });

  it('omits page/limit from the query string when not given', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce([]);

    await handleListWorkspaceActivity({ workspace_id: 'ws-1' }, client);

    const [url] = (client.get as jest.Mock).mock.calls[0];
    expect(url).not.toContain('page=');
    expect(url).not.toContain('limit=');
  });
});

describe('handleListWorkspaceRepos', () => {
  it('calls the repos endpoint', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce([]);

    await handleListWorkspaceRepos({ workspace_id: 'ws-1' }, client);

    expect(client.get).toHaveBeenCalledWith('/bff/workflow-backend/api/workspaces/ws-1/repos');
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

    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe('# Product Spec\nHello');
  });

  it('calls the REAL storage-service route — path as a query param, not a `kind` path segment', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ content: '' } as DocumentContentResponse);

    await handleReadStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND }, client);

    expect(client.get).toHaveBeenCalledWith(
      `/bff/storage-service/api/workspaces/${WS}/features/${FID}/documents/content?path=product_spec.md`,
    );
  });

  it('maps every document kind to its canonical filename', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValue({ content: '' } as DocumentContentResponse);

    await handleReadStorageDocument({ workspace_id: WS, feature_id: FID, kind: 'technical_design' }, client);
    expect(client.get).toHaveBeenLastCalledWith(expect.stringContaining('path=tech_design.md'));

    await handleReadStorageDocument({ workspace_id: WS, feature_id: FID, kind: 'tasks' }, client);
    expect(client.get).toHaveBeenLastCalledWith(expect.stringContaining('path=tasks.md'));

    await handleReadStorageDocument({ workspace_id: WS, feature_id: FID, kind: 'handoff' }, client);
    expect(client.get).toHaveBeenLastCalledWith(expect.stringContaining('path=handoff.md'));
  });

  it('returns document_not_found on 404', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(new BffRequestError('404', 404, {}));

    const result = await handleReadStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND }, client);

    expect(result.isError).toBe(true);
    const body = JSON.parse(firstText(result));
    expect(body.reason).toMatch(/document_not_found/);
    expect(body.reason).toContain(KIND);
  });

  it('returns auth error on BffAuthError', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(AUTH_ERROR);

    const result = await handleReadStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND }, client);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('Authentication failed');
  });

  it('reads a workspace-root document (no feature_id) via path, hitting the no-:fid route', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ content: 'shared notes' } as DocumentContentResponse);

    const result = await handleReadStorageDocument({ workspace_id: WS, path: 'shared/notes.md' }, client);

    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe('shared notes');
    expect(client.get).toHaveBeenCalledWith(
      `/bff/storage-service/api/workspaces/${WS}/documents/content?path=shared%2Fnotes.md`,
    );
  });

  it('reads a feature-scoped non-canonical document via path + feature_id', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ content: 'x' } as DocumentContentResponse);

    await handleReadStorageDocument({ workspace_id: WS, feature_id: FID, path: 'notes/design.md' }, client);

    expect(client.get).toHaveBeenCalledWith(
      `/bff/storage-service/api/workspaces/${WS}/features/${FID}/documents/content?path=notes%2Fdesign.md`,
    );
  });

  it('rejects when both kind and path are given', async () => {
    const client = makeClient();

    const result = await handleReadStorageDocument(
      { workspace_id: WS, feature_id: FID, kind: KIND, path: 'x.md' },
      client,
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/invalid_args/);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('rejects when neither kind nor path are given', async () => {
    const client = makeClient();

    const result = await handleReadStorageDocument({ workspace_id: WS, feature_id: FID }, client);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/invalid_args/);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('rejects kind without feature_id (canonical docs are feature-scoped)', async () => {
    const client = makeClient();

    const result = await handleReadStorageDocument({ workspace_id: WS, kind: KIND }, client);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/invalid_args/);
    expect(firstText(result)).toContain('feature_id');
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe('handleCreateStorageDocument', () => {
  const WS = 'ws-uuid-1';
  const FID = 'feat-uuid-1';
  const KIND: DocumentKind = 'technical_design';
  const CONTENT = '# Technical Design\nContent here';

  function importResponse(): ImportDocumentResponse {
    return {
      document: {
        id: 'doc-uuid-1',
        workspace_id: WS,
        feature_id: FID,
        path: 'tech_design.md',
        current_version_id: 'ver-uuid-1',
        created_at: '2026-08-23T00:00:00Z',
      },
      version: {
        id: 'ver-uuid-1',
        document_id: 'doc-uuid-1',
        snapshot_ref: 'blob-uuid-1',
        author: 'user-uuid-1',
        source: 'import',
        created_at: '2026-08-23T00:00:00Z',
      },
    };
  }

  it('posts to the import endpoint with the kind mapped to its canonical filename', async () => {
    const client = makeClient();
    client.post = jest.fn().mockResolvedValueOnce(importResponse());

    await handleCreateStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND, content: CONTENT }, client);

    expect(client.post).toHaveBeenCalledWith('/bff/storage-service/api/documents/import', {
      workspace_id: WS,
      feature_id: FID,
      path: 'tech_design.md',
      content: CONTENT,
    });
  });

  it('returns the created document id, kind, and version id on success', async () => {
    const client = makeClient();
    client.post = jest.fn().mockResolvedValueOnce(importResponse());

    const result = await handleCreateStorageDocument(
      { workspace_id: WS, feature_id: FID, kind: KIND, content: CONTENT },
      client,
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual({ id: 'doc-uuid-1', path: 'tech_design.md', version_id: 'ver-uuid-1' });
  });

  it('returns auth error on BffAuthError', async () => {
    const client = makeClient();
    client.post = jest.fn().mockRejectedValueOnce(AUTH_ERROR);

    const result = await handleCreateStorageDocument(
      { workspace_id: WS, feature_id: FID, kind: KIND, content: CONTENT },
      client,
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('Authentication failed');
  });

  it('returns error on unexpected BFF failure', async () => {
    const client = makeClient();
    client.post = jest.fn().mockRejectedValueOnce(SERVER_ERROR);

    const result = await handleCreateStorageDocument(
      { workspace_id: WS, feature_id: FID, kind: KIND, content: CONTENT },
      client,
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('500');
  });

  it('creates a workspace-root document (no feature_id) via path, sending feature_id: ""', async () => {
    const client = makeClient();
    client.post = jest.fn().mockResolvedValueOnce({
      document: {
        id: 'doc-uuid-2',
        workspace_id: WS,
        path: 'shared/notes.md',
        current_version_id: 'ver-uuid-3',
        created_at: '2026-08-23T00:00:00Z',
      },
      version: {
        id: 'ver-uuid-3',
        document_id: 'doc-uuid-2',
        snapshot_ref: 'blob-uuid-2',
        author: 'user-uuid-1',
        source: 'import',
        created_at: '2026-08-23T00:00:00Z',
      },
    } as ImportDocumentResponse);

    const result = await handleCreateStorageDocument(
      { workspace_id: WS, path: 'shared/notes.md', content: 'hello' },
      client,
    );

    expect(client.post).toHaveBeenCalledWith('/bff/storage-service/api/documents/import', {
      workspace_id: WS,
      feature_id: '',
      path: 'shared/notes.md',
      content: 'hello',
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual({
      id: 'doc-uuid-2',
      path: 'shared/notes.md',
      version_id: 'ver-uuid-3',
    });
  });

  it('rejects when neither kind nor path are given', async () => {
    const client = makeClient();

    const result = await handleCreateStorageDocument({ workspace_id: WS, feature_id: FID, content: CONTENT }, client);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/invalid_args/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('rejects kind without feature_id (canonical docs are feature-scoped)', async () => {
    const client = makeClient();

    const result = await handleCreateStorageDocument({ workspace_id: WS, kind: KIND, content: CONTENT }, client);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/invalid_args/);
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe('handleUpdateStorageDocument', () => {
  const WS = 'ws-uuid-1';
  const FID = 'feat-uuid-1';
  const KIND: DocumentKind = 'product_spec';
  const CONTENT = '# Product Spec\nUpdated content';

  it('PUTs to the content endpoint — path as a query param, not a `kind` path segment', async () => {
    const client = makeClient();
    const resp: PutDocumentContentResponse = { ok: true, version_id: 'ver-uuid-2' };
    client.put = jest.fn().mockResolvedValueOnce(resp);

    await handleUpdateStorageDocument({ workspace_id: WS, feature_id: FID, kind: KIND, content: CONTENT }, client);

    expect(client.put).toHaveBeenCalledWith(
      `/bff/storage-service/api/workspaces/${WS}/features/${FID}/documents/content?path=product_spec.md`,
      { content: CONTENT },
    );
  });

  it('returns ok and the new version id on success', async () => {
    const client = makeClient();
    const resp: PutDocumentContentResponse = { ok: true, version_id: 'ver-uuid-2' };
    client.put = jest.fn().mockResolvedValueOnce(resp);

    const result = await handleUpdateStorageDocument(
      { workspace_id: WS, feature_id: FID, kind: KIND, content: CONTENT },
      client,
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual(resp);
  });

  it('returns document_not_found (with a hint to create first) on 404', async () => {
    const client = makeClient();
    client.put = jest.fn().mockRejectedValueOnce(new BffRequestError('404', 404, {}));

    const result = await handleUpdateStorageDocument(
      { workspace_id: WS, feature_id: FID, kind: KIND, content: CONTENT },
      client,
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(firstText(result));
    expect(body.reason).toMatch(/document_not_found/);
    expect(body.reason).toContain(KIND);
    expect(body.reason).toContain('create_storage_document');
  });

  it('returns auth error on BffAuthError', async () => {
    const client = makeClient();
    client.put = jest.fn().mockRejectedValueOnce(AUTH_ERROR);

    const result = await handleUpdateStorageDocument(
      { workspace_id: WS, feature_id: FID, kind: KIND, content: CONTENT },
      client,
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('Authentication failed');
  });

  it('returns error on unexpected BFF failure', async () => {
    const client = makeClient();
    client.put = jest.fn().mockRejectedValueOnce(SERVER_ERROR);

    const result = await handleUpdateStorageDocument(
      { workspace_id: WS, feature_id: FID, kind: KIND, content: CONTENT },
      client,
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('500');
  });

  it('updates a workspace-root document (no feature_id) via path, hitting the no-:fid route', async () => {
    const client = makeClient();
    const resp: PutDocumentContentResponse = { ok: true, version_id: 'ver-uuid-4' };
    client.put = jest.fn().mockResolvedValueOnce(resp);

    const result = await handleUpdateStorageDocument(
      { workspace_id: WS, path: 'shared/notes.md', content: 'updated' },
      client,
    );

    expect(client.put).toHaveBeenCalledWith(
      `/bff/storage-service/api/workspaces/${WS}/documents/content?path=shared%2Fnotes.md`,
      { content: 'updated' },
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual(resp);
  });

  it('document_not_found for a path-based document names the path, not a kind', async () => {
    const client = makeClient();
    client.put = jest.fn().mockRejectedValueOnce(new BffRequestError('404', 404, {}));

    const result = await handleUpdateStorageDocument(
      { workspace_id: WS, path: 'shared/notes.md', content: 'updated' },
      client,
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(firstText(result));
    expect(body.reason).toContain('path="shared/notes.md"');
    expect(body.reason).toContain('workspace root');
  });

  it('rejects when both kind and path are given', async () => {
    const client = makeClient();

    const result = await handleUpdateStorageDocument(
      { workspace_id: WS, feature_id: FID, kind: KIND, path: 'x.md', content: CONTENT },
      client,
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/invalid_args/);
    expect(client.put).not.toHaveBeenCalled();
  });

  it('rejects kind without feature_id (canonical docs are feature-scoped)', async () => {
    const client = makeClient();

    const result = await handleUpdateStorageDocument({ workspace_id: WS, kind: KIND, content: CONTENT }, client);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/invalid_args/);
    expect(client.put).not.toHaveBeenCalled();
  });
});

describe('handleListWorkspaceDocuments', () => {
  it('hits the workspace-wide route when feature_id is omitted', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ documents: [{ id: 'doc-1' }] });

    const result = await handleListWorkspaceDocuments({ workspace_id: 'ws-1' }, client);

    expect(client.get).toHaveBeenCalledWith('/bff/storage-service/api/workspaces/ws-1/documents');
    expect(JSON.parse(firstText(result))).toEqual({
      documents: [{ id: 'doc-1' }],
      truncated: false,
    });
  });

  it('hits the feature-scoped route when feature_id is given', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ documents: [] });

    await handleListWorkspaceDocuments({ workspace_id: 'ws-1', feature_id: 'feat-1' }, client);

    expect(client.get).toHaveBeenCalledWith(
      '/bff/storage-service/api/workspaces/ws-1/features/feat-1/documents',
    );
  });

  it('appends limit to the query string when given', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ documents: [] });

    await handleListWorkspaceDocuments({ workspace_id: 'ws-1', limit: 100 }, client);

    expect(client.get).toHaveBeenCalledWith(
      '/bff/storage-service/api/workspaces/ws-1/documents?limit=100',
    );
  });

  it('relays truncated=true from the upstream response', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ documents: [{ id: 'doc-1' }], truncated: true });

    const result = await handleListWorkspaceDocuments({ workspace_id: 'ws-1' }, client);

    expect(JSON.parse(firstText(result))).toEqual({
      documents: [{ id: 'doc-1' }],
      truncated: true,
    });
  });
});

describe('handleGetDocumentVersions', () => {
  it('calls the versions endpoint and relays the array', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ versions: [{ id: 'v1' }] });

    const result = await handleGetDocumentVersions({ document_id: 'doc-1' }, client);

    expect(client.get).toHaveBeenCalledWith('/bff/storage-service/api/documents/doc-1/versions');
    expect(JSON.parse(firstText(result))).toEqual({ versions: [{ id: 'v1' }], truncated: false });
  });

  it('appends limit to the query string when given', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ versions: [] });

    await handleGetDocumentVersions({ document_id: 'doc-1', limit: 50 }, client);

    expect(client.get).toHaveBeenCalledWith(
      '/bff/storage-service/api/documents/doc-1/versions?limit=50',
    );
  });

  it('returns document_not_found on 404', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(new BffRequestError('404', 404, {}));

    const result = await handleGetDocumentVersions({ document_id: 'missing' }, client);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/document_not_found/);
  });
});

describe('handleUpdateFeatureStage', () => {
  const WS = 'ws-uuid-1';
  const FID = 'feat-uuid-1';

  function successResponse(overrides: Partial<StageTransitionResponse> = {}): StageTransitionResponse {
    return {
      ok: true,
      feature_id: FID,
      stage: 'product_spec',
      action: 'approve',
      review_status: 'approved',
      feature_status: 'in_tdd',
      current_stage: 'technical_design',
      commit_sha: 'abc123',
      branch: null,
      ...overrides,
    };
  }

  it('posts stage/action to the stage-transition endpoint, omitting comment when absent', async () => {
    const client = makeClient();
    client.post = jest.fn().mockResolvedValueOnce(successResponse());

    await handleUpdateFeatureStage(
      { workspace_id: WS, feature_id: FID, stage: 'product_spec', action: 'approve' },
      client,
    );

    expect(client.post).toHaveBeenCalledWith(
      `/bff/hermes-agent/api/v1/features/${FID}/stage-transition`,
      { stage: 'product_spec', action: 'approve' },
    );
  });

  it('includes comment in the body when provided (reject)', async () => {
    const client = makeClient();
    client.post = jest.fn().mockResolvedValueOnce(
      successResponse({ action: 'reject', review_status: 'rejected', feature_status: 'in_design', current_stage: 'product_spec' }),
    );

    const result = await handleUpdateFeatureStage(
      { workspace_id: WS, feature_id: FID, stage: 'product_spec', action: 'reject', comment: 'needs more detail' },
      client,
    );

    expect(client.post).toHaveBeenCalledWith(
      `/bff/hermes-agent/api/v1/features/${FID}/stage-transition`,
      { stage: 'product_spec', action: 'reject', comment: 'needs more detail' },
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toMatchObject({ action: 'reject', review_status: 'rejected' });
  });

  it('returns the response verbatim on approve success', async () => {
    const client = makeClient();
    const response = successResponse();
    client.post = jest.fn().mockResolvedValueOnce(response);

    const result = await handleUpdateFeatureStage(
      { workspace_id: WS, feature_id: FID, stage: 'product_spec', action: 'approve' },
      client,
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual(response);
  });

  it('returns the response verbatim on reopen success', async () => {
    const client = makeClient();
    const response = successResponse({
      action: 'reopen',
      review_status: 'draft',
      feature_status: 'in_design',
      current_stage: 'product_spec',
    });
    client.post = jest.fn().mockResolvedValueOnce(response);

    const result = await handleUpdateFeatureStage(
      { workspace_id: WS, feature_id: FID, stage: 'product_spec', action: 'reopen', comment: 'reopening for revision' },
      client,
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual(response);
  });

  it('surfaces needs_status_change as { ok: false, reason } rather than a plain success', async () => {
    const client = makeClient();
    client.post = jest.fn().mockResolvedValueOnce({
      ok: false,
      feature_id: FID,
      stage: 'product_spec',
      feature_status: 'backlog',
      needs_status_change: true,
      target_status: 'in_design',
      message: 'Move to In Design before approving a stage.',
    } as StageTransitionResponse);

    const result = await handleUpdateFeatureStage(
      { workspace_id: WS, feature_id: FID, stage: 'product_spec', action: 'approve' },
      client,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(firstText(result));
    expect(parsed).toMatchObject({
      ok: false,
      reason: 'needs_status_change',
      target_status: 'in_design',
    });
  });

  it('returns auth error on BffAuthError', async () => {
    const client = makeClient();
    client.post = jest.fn().mockRejectedValueOnce(AUTH_ERROR);

    const result = await handleUpdateFeatureStage(
      { workspace_id: WS, feature_id: FID, stage: 'product_spec', action: 'approve' },
      client,
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('Authentication failed');
  });

  it('returns error on unexpected BFF failure', async () => {
    const client = makeClient();
    client.post = jest.fn().mockRejectedValueOnce(SERVER_ERROR);

    const result = await handleUpdateFeatureStage(
      { workspace_id: WS, feature_id: FID, stage: 'product_spec', action: 'approve' },
      client,
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('500');
  });
});

describe('handleWhoami', () => {
  it('calls GET /api/me and relays the data envelope', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({
      success: true,
      data: { user: { id: 'u1' }, memberships: [] },
    });

    const result = await handleWhoami(client);

    expect(client.get).toHaveBeenCalledWith('/bff/user-service/api/me');
    expect(JSON.parse(firstText(result))).toEqual({ user: { id: 'u1' }, memberships: [] });
  });
});

describe('resolveWorkspaceId', () => {
  it('uses the explicitly provided workspace_id when set', () => {
    const result = resolveWorkspaceId('ws-explicit', 'ws-default');
    expect(result).toEqual({ workspaceId: 'ws-explicit' });
  });

  it('falls back to the default workspace_id when none is provided', () => {
    const result = resolveWorkspaceId(undefined, 'ws-default');
    expect(result).toEqual({ workspaceId: 'ws-default' });
  });

  it('returns an error result when neither is available', () => {
    const result = resolveWorkspaceId(undefined, undefined);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.isError).toBe(true);
      expect(firstText(result.error)).toMatch(/workspace_id/);
    }
  });
});

describe('resolveOrgId', () => {
  it('uses the explicitly provided org_id when set', () => {
    expect(resolveOrgId('org-explicit', 'org-default')).toEqual({ orgId: 'org-explicit' });
  });

  it('falls back to the default org_id when none is provided', () => {
    expect(resolveOrgId(undefined, 'org-default')).toEqual({ orgId: 'org-default' });
  });

  it('returns an error result when neither is available', () => {
    const result = resolveOrgId(undefined, undefined);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.isError).toBe(true);
      expect(firstText(result.error)).toMatch(/org_id/);
    }
  });
});
