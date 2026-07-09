# workflow-mcp

MCP server for the [workflow](https://github.com/tiendv89/agent-workflow) task-creation API.
Exposes two tools — `get_feature` and `create_tasks` — over stdio, authenticated via a
`session_id` browser cookie obtained from the BFF.

## Requirements

- Node.js 18+
- Access to a running `workflow-bff` instance

## Install

```sh
npm install
npm run build
npm link
```

This compiles TypeScript to `dist/` and symlinks the `workflow-mcp` binary onto your `PATH`.

## Configure with Claude (local scope)

```sh
claude mcp add workflow-mcp \
  --scope local \
  --env WORKFLOW_BFF_URL=http://localhost:8090 \
  --env WORKFLOW_SESSION_COOKIE=<your-session-id> \
  -- workflow-mcp
```

The `install.sh` script in the parent `workflow` repo runs this command for you.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `WORKFLOW_BFF_URL` | `http://localhost:8090` | Base URL of the workflow BFF |
| `WORKFLOW_SESSION_COOKIE` | — | Value of the `session_id` cookie from a browser login session |

To get a session cookie: log in to the workflow UI in your browser, open DevTools →
Application → Cookies, copy the value of `session_id`.

## Tools

### `get_feature`

Resolve a feature by its name.  Returns the feature's UUID, title, status, and stage.


**Input:**

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | yes | Workspace UUID |
| `name` | string | yes | Exact feature name (e.g. `workflow-db`) |

**Returns:** feature object with `id`, `feature_id`, `feature_name`, `title`, `status`, `current_stage`, `task_counts`, etc.

**Errors:**
- feature not found — check the name spelling
- `401` — session expired; re-run `claude mcp add …` with a fresh cookie

### `create_tasks`

Bulk-create tasks for a go-owned feature in one all-or-nothing write.

**Input:**

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | yes | Workspace UUID |
| `feature_id` | string | yes | UUID returned by `get_feature` |
| `tasks` | array | yes | List of task objects (see below) |

Each task object:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Task ID (e.g. `T1`) |
| `title` | string | yes | Short task title |
| `repo` | string | yes | Repo ID from `workspace.yaml` |
| `actor_type` | `"agent"` \| `"human"` \| `"either"` | yes | Who executes the task |
| `depends_on` | string[] | yes | IDs of prerequisite tasks (`[]` if none) |

**Returns:** `{ created: number }` on success.

**Conflict / failure list:**
If one or more tasks already exist, the entire batch is rejected and the response
includes a `failures` array:

```json
{
  "error": "some tasks already exist",
  "failures": [
    { "id": "T1", "reason": "already exists" }
  ]
}
```

When `create_tasks` returns a failure list:
1. Show the full list to the user.
2. Ask: **stop / retry (fix the conflicts first) / skip-failing-and-retry-rest**.
3. If **skip-failing-and-retry-rest**: re-call `create_tasks` with the non-failing subset.
4. If **retry**: the user must resolve the conflicts (e.g. delete duplicate tasks), then retry.
5. If **stop**: abort and surface the failures for manual resolution.

**Errors:**
- `401` — session expired; refresh the cookie
- `404` — feature not found; verify `feature_id`
- `409` — tasks already exist (see failure list above)
- `422` — invalid task definition; check required fields

### `unblock_task`

Unblock a blocked workflow task. Resolves feature/task names to UUIDs automatically, then calls
the unblock endpoint. The resume state (e.g. `ready` or `in_review`) is derived server-side from
`blocked_from_status` — no target choice is needed.

**Input:**

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | yes | Workspace UUID |
| `feature` | string | yes | Feature name (slug) or UUID, e.g. `"executor-self-briefing"` |
| `task` | string | yes | Task name (e.g. `"T3"`) or UUID |
| `note` | string | no | Optional note explaining what was done to resolve the block |

**Returns on success:** `{ ok: true, from: "blocked", to: "<resume-state>" }`

**Returns on failure:** `{ ok: false, reason: "<code>" }` where `reason` is one of:
- `task_not_blocked` — the task is not in `blocked` state (409 — already transitioned or lost race)
- `task_not_found` — the task UUID does not exist (404)
- `access_denied` — caller's org does not own the task (403)
- `feature_not_found: "<name> in workspace <id>"` — feature name resolved to nothing
- `task_not_found: "<name> in feature <id>"` — task name resolved to nothing

**Errors:**
- `401` — session expired; refresh the `WORKFLOW_SESSION_COOKIE`

## Create-tasks flow (for agents)

1. The `tasks` stage must be approved before creating tasks.
2. Call `get_feature` with the exact feature name to obtain its `id`.
3. Parse the `tasks.md` index table to build the task list (`actor_type` defaults to `agent`).
4. Call `create_tasks` with the feature `id` and the full task list.
5. On success: the backend's auto-ready logic marks no-dependency tasks `ready`.
6. On conflict: follow the failure-list handling above.

## Development

```sh
npm run build        # compile TypeScript → dist/
npm run typecheck    # type-check without emitting
npm run lint         # lint src/
npm test             # run Jest tests
```

### `read_storage_document`

Read a `go`-owned feature's document content from `storage-service`. Scoped to `go`-owned features only — `ts`-owned feature documents remain git-backed and are unaffected by this tool.

**Input:**

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | yes | Workspace UUID |
| `feature_id` | string | yes | Feature UUID |
| `kind` | `"product_spec"` \| `"technical_design"` \| `"tasks"` \| `"handoff"` | yes | Document kind to read |

**Returns:** raw markdown content string.

**Errors:**
- `{ ok: false, reason: "document_not_found: ..." }` — no document of that kind exists for the feature
- `401` — session expired; refresh the `WORKFLOW_SESSION_COOKIE`

### `write_storage_document`

Create or import a markdown document into `storage-service` for a `go`-owned feature. Scoped to `go`-owned features only — `ts`-owned feature documents remain git-backed.

**Input:**

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | yes | Workspace UUID |
| `feature_id` | string | yes | Feature UUID |
| `kind` | `"product_spec"` \| `"technical_design"` \| `"tasks"` \| `"handoff"` | yes | Document kind to write |
| `content` | string | yes | Markdown content to import |

**Returns:** `{ ok: true, id: "<doc-uuid>", kind: "<kind>", slug: "<slug>" }`

**Errors:**
- `401` — session expired; refresh the `WORKFLOW_SESSION_COOKIE`
- `409` — a document of that kind already exists for the feature

## Architecture

```
stdin/stdout (stdio MCP transport)
    │
    ▼
McpServer (MCP TS SDK)
    │
    ├── get_feature ──────────────► GET  /bff/workflow-backend/api/workspaces/:ws_id/features?name=<name>                                               (workflow-bff → workflow-backend)
    ├── create_tasks ─────────────► POST /bff/workflow-backend/api/workspaces/:ws_id/features/:id/tasks                                                 (workflow-bff → workflow-backend)
    ├── unblock_task ─────────────► POST /bff/workflow-backend/api/workspaces/:ws_id/features/:feat_id/tasks/:task_id/unblock                           (workflow-bff → workflow-backend)
    ├── read_storage_document ────► GET  /bff/storage-service/api/workspaces/:ws_id/features/:feat_id/documents/:kind/content                           (workflow-bff → storage-service)
    └── write_storage_document ───► POST /bff/storage-service/api/documents/import                                                                      (workflow-bff → storage-service)
```

All requests carry `Cookie: session_id=<value>` from `WORKFLOW_SESSION_COOKIE`.
No DB credentials are held by this server.
