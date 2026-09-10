/**
 * E2E test: workflow-mcp → fake BFF → response assertions
 *
 * Uses a fake HTTP server to avoid external dependencies.
 * Covers the get_feature flow (search-by-name → feature detail, now bundling
 * tasks/activity/documents/source_state in one call) and a couple of the
 * other read-only tools, over a real HTTP round trip — including the
 * `Authorization: Bearer` header the real BFF actually reads.
 */

import * as http from 'http';
import { AddressInfo } from 'net';
import { BffClient } from './bffClient';
import { handleGetFeature, handleListWorkspaceRepos, handleGetTask, Feature } from './tools';

const WORKSPACE_ID = 'ws-e2e-test';
const FEATURE_UUID = 'feat-uuid-e2e-001';
const FEATURE_NAME = 'e2e-test-feature';

const SEEDED_FEATURE: Feature = {
  id: FEATURE_UUID,
  feature_id: FEATURE_NAME,
  feature_name: FEATURE_NAME,
  title: 'E2E Test Feature',
  status: 'in_implementation',
  current_stage: 'tasks',
  owner: 'go',
};

interface FakeBff {
  server: http.Server;
  baseUrl: string;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  if (!item || item.type !== 'text' || item.text === undefined) throw new Error('Expected text content');
  return item.text;
}

function startFakeBff(): Promise<FakeBff> {
  const server = http.createServer((req, res) => {
    const auth = req.headers['authorization'] ?? '';
    if (auth !== 'Bearer test-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const url = new URL(req.url!, 'http://localhost');
    const { pathname } = url;

    // GET /bff/workflow-backend/api/workspaces/:ws_id/features?name=...
    const searchMatch = pathname.match(/^\/bff\/workflow-backend\/api\/workspaces\/([^/]+)\/features$/);
    if (searchMatch && req.method === 'GET') {
      const name = url.searchParams.get('name') ?? '';
      const features = name === FEATURE_NAME ? [SEEDED_FEATURE] : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { items: features, total: features.length, page: 1, limit: 0 } }));
      return;
    }

    // GET /bff/workflow-backend/api/workspaces/:ws_id/features/:feature_id — full detail
    const detailMatch = pathname.match(
      /^\/bff\/workflow-backend\/api\/workspaces\/([^/]+)\/features\/([^/]+)$/,
    );
    if (detailMatch && req.method === 'GET' && detailMatch[2] === FEATURE_UUID) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            ...SEEDED_FEATURE,
            workspace_id: WORKSPACE_ID,
            tasks: [{ id: 'task-1', task_name: 'T1', status: 'ready' }],
            activity: [{ action: 'feature_created', occurred_at: '2026-01-01T00:00:00Z' }],
            documents: [],
            source_state: { stale: false },
          },
        }),
      );
      return;
    }

    // GET /bff/workflow-backend/api/workspaces/:ws_id/repos
    const reposMatch = pathname.match(/^\/bff\/workflow-backend\/api\/workspaces\/([^/]+)\/repos$/);
    if (reposMatch && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          data: [{ id: 'repo-1', repo_url: 'https://github.com/acme/repo', is_management_repo: true }],
        }),
      );
      return;
    }

    // GET /bff/workflow-backend/api/workspaces/:ws_id/tasks/:task_id
    const taskMatch = pathname.match(/^\/bff\/workflow-backend\/api\/workspaces\/([^/]+)\/tasks\/([^/]+)$/);
    if (taskMatch && req.method === 'GET') {
      if (taskMatch[2] !== 'task-1') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { id: 'task-1', task_name: 'T1', status: 'ready' } }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('E2E: workflow-mcp → BFF', () => {
  let fakeBff: FakeBff;
  let client: BffClient;

  beforeAll(async () => {
    fakeBff = await startFakeBff();
    client = new BffClient(() => ({ bffUrl: fakeBff.baseUrl, bearerToken: 'test-token' }));
  });

  afterAll((done) => {
    fakeBff.server.close(done);
  });

  describe('get_feature', () => {
    it('resolves by name and returns the full bundled detail', async () => {
      const result = await handleGetFeature({ workspace_id: WORKSPACE_ID, name: FEATURE_NAME }, client);

      expect(result.isError).toBeFalsy();
      const feature = JSON.parse(firstText(result));
      expect(feature.id).toBe(FEATURE_UUID);
      expect(feature.feature_name).toBe(FEATURE_NAME);
      expect(feature.owner).toBe('go');
      expect(feature.tasks).toEqual([{ id: 'task-1', task_name: 'T1', status: 'ready' }]);
      expect(feature.activity).toHaveLength(1);
      expect(feature.source_state).toEqual({ stale: false });
    });

    it('returns a not-found message for an unknown feature name', async () => {
      const result = await handleGetFeature({ workspace_id: WORKSPACE_ID, name: 'no-such-feature' }, client);

      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/feature_not_found/i);
    });

    it('returns auth error and re-auth guidance when the token is invalid', async () => {
      const badClient = new BffClient(() => ({ bffUrl: fakeBff.baseUrl, bearerToken: 'expired-or-wrong' }));
      const result = await handleGetFeature({ workspace_id: WORKSPACE_ID, name: FEATURE_NAME }, badClient);

      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/Actorium: Connect/);
    });
  });

  describe('list_workspace_repos', () => {
    it('returns the workspace\'s repo list', async () => {
      const result = await handleListWorkspaceRepos({ workspace_id: WORKSPACE_ID }, client);

      expect(result.isError).toBeFalsy();
      const repos = JSON.parse(firstText(result));
      expect(repos).toEqual([
        { id: 'repo-1', repo_url: 'https://github.com/acme/repo', is_management_repo: true },
      ]);
    });
  });

  describe('get_task', () => {
    it('returns task detail by UUID', async () => {
      const result = await handleGetTask({ workspace_id: WORKSPACE_ID, task_id: 'task-1' }, client);

      expect(result.isError).toBeFalsy();
      const task = JSON.parse(firstText(result));
      expect(task).toEqual({ id: 'task-1', task_name: 'T1', status: 'ready' });
    });

    it('returns task_not_found for an unknown task id', async () => {
      const result = await handleGetTask({ workspace_id: WORKSPACE_ID, task_id: 'nope' }, client);

      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/task_not_found/);
    });
  });
});
