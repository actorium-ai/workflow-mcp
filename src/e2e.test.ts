/**
 * E2E test: workflow-mcp → fake BFF → response assertions
 *
 * Uses a fake HTTP server to avoid external dependencies.
 * Covers:
 *  1. Happy path: get_feature → create_tasks → rows created, no-dep tasks are 'ready'
 *  2. Conflict path: duplicate batch → whole batch rejected with failure list
 */

import * as http from 'http';
import { AddressInfo } from 'net';
import { BffClient } from './bffClient';
import { handleGetFeature, handleCreateTasks, Feature, CreatedTask } from './tools';

const WORKSPACE_ID = 'ws-e2e-test';
const FEATURE_UUID = 'feat-uuid-e2e-001';
const FEATURE_NAME = 'e2e-test-feature';

const SEEDED_FEATURE: Feature = {
  id: FEATURE_UUID,
  feature_id: FEATURE_NAME,
  feature_name: FEATURE_NAME,
  title: 'E2E Test Feature',
  feature_status: 'in_implementation',
  current_stage: 'tasks',
  owner: 'go',
};

interface FakeBff {
  server: http.Server;
  existingTasks: Set<string>;
  baseUrl: string;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  if (!item || item.type !== 'text' || item.text === undefined) throw new Error('Expected text content');
  return item.text;
}

function startFakeBff(): Promise<FakeBff> {
  const existingTasks = new Set<string>();

  const server = http.createServer((req, res) => {
    const cookie = req.headers['cookie'] ?? '';
    if (!cookie.includes('session_id=test-session')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const url = new URL(req.url!, 'http://localhost');
    const { pathname } = url;

    // GET /api/workspaces/:ws_id/features?name=...
    const featuresMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/features$/);
    if (featuresMatch && req.method === 'GET') {
      const name = url.searchParams.get('name') ?? '';
      const features = name === FEATURE_NAME ? [SEEDED_FEATURE] : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ features }));
      return;
    }

    // POST /api/workspaces/:ws_id/features/:feature_id/tasks
    const tasksMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/features\/([^/]+)\/tasks$/);
    if (tasksMatch && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const { tasks } = JSON.parse(body) as {
          tasks: Array<{ name: string; title: string; repo: string; depends_on: string[]; actor_type?: string }>;
        };

        const failures = tasks
          .filter((t) => existingTasks.has(t.name))
          .map((t) => ({ name: t.name, reason: 'task already exists' }));

        if (failures.length > 0) {
          // Whole batch rejected — nothing created
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ failures }));
          return;
        }

        // Backend auto-ready: no-dependency tasks start as 'ready', others 'todo'
        const created: CreatedTask[] = tasks.map((t) => ({
          task_id: `uuid-${t.name}`,
          task_name: t.name,
          title: t.title,
          status: t.depends_on.length === 0 ? 'ready' : 'todo',
        }));
        tasks.forEach((t) => existingTasks.add(t.name));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tasks: created }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, existingTasks, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('E2E: workflow-mcp → BFF', () => {
  let fakeBff: FakeBff;
  let client: BffClient;

  beforeAll(async () => {
    fakeBff = await startFakeBff();
    client = new BffClient(fakeBff.baseUrl, 'test-session');
  });

  afterAll(
    (done) => {
      fakeBff.server.close(done);
    },
  );

  beforeEach(() => {
    fakeBff.existingTasks.clear();
  });

  // ── get_feature ──────────────────────────────────────────────────────────────

  describe('get_feature', () => {
    it('returns the feature when it exists in the workspace', async () => {
      const result = await handleGetFeature({ workspace_id: WORKSPACE_ID, name: FEATURE_NAME }, client);

      expect(result.isError).toBeFalsy();
      const feature = JSON.parse(firstText(result)) as Feature;
      expect(feature.id).toBe(FEATURE_UUID);
      expect(feature.feature_name).toBe(FEATURE_NAME);
      expect(feature.owner).toBe('go');
    });

    it('returns a not-found message for an unknown feature name', async () => {
      const result = await handleGetFeature({ workspace_id: WORKSPACE_ID, name: 'no-such-feature' }, client);

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toMatch(/not found/i);
    });

    it('returns auth error and re-auth guidance when session is invalid', async () => {
      const badClient = new BffClient(fakeBff.baseUrl, 'expired-or-wrong');
      const result = await handleGetFeature({ workspace_id: WORKSPACE_ID, name: FEATURE_NAME }, badClient);

      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/WORKFLOW_SESSION_COOKIE/);
    });
  });

  // ── create_tasks — happy path ─────────────────────────────────────────────────

  describe('create_tasks — happy path', () => {
    const tasks = [
      { name: 'T1', title: 'First Task', repo: 'workflow-backend', depends_on: [] },
      { name: 'T2', title: 'Second Task', repo: 'workflow-backend', depends_on: ['T1'] },
      { name: 'T3', title: 'Third Task', repo: 'workflow-backend', depends_on: [] },
    ];

    it('creates all tasks and returns a list of the same length', async () => {
      const result = await handleCreateTasks(
        { workspace_id: WORKSPACE_ID, feature_id: FEATURE_UUID, tasks },
        client,
      );

      expect(result.isError).toBeFalsy();
      const created = JSON.parse(firstText(result)) as CreatedTask[];
      expect(created).toHaveLength(3);
    });

    it('marks no-dependency tasks as ready (orchestrator eligibility scan)', async () => {
      const result = await handleCreateTasks(
        { workspace_id: WORKSPACE_ID, feature_id: FEATURE_UUID, tasks },
        client,
      );

      const created = JSON.parse(firstText(result)) as CreatedTask[];
      const t1 = created.find((t) => t.task_name === 'T1');
      const t3 = created.find((t) => t.task_name === 'T3');
      expect(t1?.status).toBe('ready');
      expect(t3?.status).toBe('ready');
    });

    it('marks tasks with dependencies as todo', async () => {
      const result = await handleCreateTasks(
        { workspace_id: WORKSPACE_ID, feature_id: FEATURE_UUID, tasks },
        client,
      );

      const created = JSON.parse(firstText(result)) as CreatedTask[];
      const t2 = created.find((t) => t.task_name === 'T2');
      expect(t2?.status).toBe('todo');
    });

    it('full flow: get_feature UUID → create_tasks succeeds', async () => {
      // Step 1: resolve feature by name
      const featureResult = await handleGetFeature(
        { workspace_id: WORKSPACE_ID, name: FEATURE_NAME },
        client,
      );
      expect(featureResult.isError).toBeFalsy();
      const feature = JSON.parse(firstText(featureResult)) as Feature;

      // Step 2: create tasks using the UUID returned by get_feature
      const createResult = await handleCreateTasks(
        {
          workspace_id: WORKSPACE_ID,
          feature_id: feature.id,
          tasks: [{ name: 'T1', title: 'First', repo: 'workflow-backend', depends_on: [] }],
        },
        client,
      );
      expect(createResult.isError).toBeFalsy();
      const created = JSON.parse(firstText(createResult)) as CreatedTask[];
      expect(created[0]?.task_name).toBe('T1');
      expect(created[0]?.status).toBe('ready');
    });
  });

  // ── create_tasks — conflict path ──────────────────────────────────────────────

  describe('create_tasks — conflict path', () => {
    const tasks = [
      { name: 'T1', title: 'First Task', repo: 'workflow-backend', depends_on: [] },
      { name: 'T2', title: 'Second Task', repo: 'workflow-backend', depends_on: ['T1'] },
    ];

    it('rejects the whole batch when all tasks already exist', async () => {
      await handleCreateTasks({ workspace_id: WORKSPACE_ID, feature_id: FEATURE_UUID, tasks }, client);

      const result = await handleCreateTasks(
        { workspace_id: WORKSPACE_ID, feature_id: FEATURE_UUID, tasks },
        client,
      );

      expect(result.isError).toBe(true);
    });

    it('returns the failure list with task names and reasons', async () => {
      await handleCreateTasks({ workspace_id: WORKSPACE_ID, feature_id: FEATURE_UUID, tasks }, client);

      const result = await handleCreateTasks(
        { workspace_id: WORKSPACE_ID, feature_id: FEATURE_UUID, tasks },
        client,
      );

      const text = firstText(result);
      expect(text).toContain('T1');
      expect(text).toContain('T2');
      expect(text).toMatch(/task already exists/i);
    });

    it('rejects the whole batch even when only one task is a duplicate', async () => {
      // Create only T1 first
      await handleCreateTasks(
        {
          workspace_id: WORKSPACE_ID,
          feature_id: FEATURE_UUID,
          tasks: [{ name: 'T1', title: 'First Task', repo: 'workflow-backend', depends_on: [] }],
        },
        client,
      );

      // Attempt to create [T1, T2] — T1 is a duplicate, so the whole batch must be rejected
      const result = await handleCreateTasks(
        { workspace_id: WORKSPACE_ID, feature_id: FEATURE_UUID, tasks },
        client,
      );

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('T1');
      expect(firstText(result)).toMatch(/task already exists/i);
      // T2 should NOT have been created
      expect(fakeBff.existingTasks.has('T2')).toBe(false);
    });

    it('does not create any tasks on conflict — nothing is persisted', async () => {
      // First call succeeds — T1 and T2 created
      await handleCreateTasks({ workspace_id: WORKSPACE_ID, feature_id: FEATURE_UUID, tasks }, client);
      expect(fakeBff.existingTasks.size).toBe(2);

      // Second call with same batch conflicts — count must not increase
      await handleCreateTasks({ workspace_id: WORKSPACE_ID, feature_id: FEATURE_UUID, tasks }, client);
      expect(fakeBff.existingTasks.size).toBe(2);
    });
  });
});
