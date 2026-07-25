# actorium-mcp

Read-only MCP server for Actorium.
Gives a coding agent full context on features, tasks, PRs, activity, documents, and identity —
no mutation tools, so it's safe to hand to any agent that only needs to *understand* a workspace,
not change it.

## Requirements

- Node.js 18+
- Access to a running `actorium` instance

## Install

```sh
npm install -g @actorium-ai/actorium-mcp
```

Run `actorium-mcp --version` (or `-v`) to check what's installed — prints the installed
package's version and exits immediately, without starting the MCP server. The Actorium VS
Code extension uses this to detect whether the CLI is installed and to compare it against the
backend's minimum supported version.

### Default workspace/org resolution

Every tool's optional `workspace_id` (and `list_workspaces`'s `org_id`) falls back to a default
when omitted, resolved in this order:

1. **The workspace manifest** — `.actorium/workspace.json`, written by the extension at a linked
   workspace folder's root (alongside AGENTS.md). actorium-mcp walks upward from its own working
   directory looking for this file, so it resolves the workspace it's running for directly from
   the folder it's in. This is what makes it safe to have **multiple VS Code windows open on
   different workspaces at once** — each one's actorium-mcp process (and its coding agent's
   terminal) still resolves to the correct workspace, regardless of what any other window is doing.
2. Otherwise, the shared credential file's stored `workspace_id`/`org_id` — a single machine-wide
   "last selected" value, so it's only a reasonable default when actorium-mcp is running from
   somewhere outside any linked workspace folder (or the manifest hasn't been written yet).

An explicit `workspace_id`/`org_id` argument on the tool call always wins over both.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `API_URL` | `http://localhost:8090` | Base URL of the workflow BFF |
| `WORKFLOW_TOKEN` | — | Bearer JWT — overrides the shared credential file |

## Tools

### `get_feature`

Resolve a feature by name. Returns the **full** feature detail in one call — status/stage,
documents, tasks, activity timeline, and sync state — not just a bare summary. The embedded
activity timeline is capped at the 50 most recent events — use `list_workspace_activity` for
the full history.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `name` | string | yes | Exact feature name (e.g. `workflow-db`) |

**Errors:** feature not found (name mismatch) · `401` — reconnect via `Actorium: Connect` or refresh your token/cookie.

### `list_workspaces`

List every workspace in an organization.

| Field | Type | Required | Description |
|---|---|---|---|
| `org_id` | string | no | Organization UUID |

### `search_features`

Search/list features in a workspace. Set `include_tasks` to embed each feature's task list and
avoid N+1 `get_task` calls. `limit` defaults to 50 and is capped at 1000 server-side if omitted
or exceeded.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `status` | string | no | Filter by feature status |
| `title` | string | no | Filter by title substring |
| `sort` | string | no | Sort order (server-defined field names) |
| `page` / `limit` | number | no | Pagination |
| `include_tasks` | boolean | no | Embed each feature's tasks |

### `search_tasks`

Search/list tasks — across the whole workspace, or scoped to one feature via `feature_id`.
`limit` defaults to 50 and is capped at 1000 server-side if omitted or exceeded.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `feature_id` | string | no | Restrict to one feature (omit for workspace-wide) |
| `task_id`, `title`, `status`, `repo` | string | no | Filters |
| `sort`, `page`, `limit` | — | no | Sort/pagination |

### `get_task`

Full task detail: execution info (actor, last update), both PR refs (implementation +
workspace/handoff), a per-task activity timeline (capped at the 50 most recent events), and
dependency names.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `task_id` | string | yes | Task UUID (from `search_tasks`/`get_feature`) |

**Errors:** `{ ok: false, reason: "task_not_found: ..." }` on 404.

### `get_task_diff`

A task's PR file list + unified diff (GitHub-backed, via workflow-backend). Empty (not an error)
if the task has no PR yet. Large diffs are size-capped server-side (file count, per-file patch,
and the unified diff itself) — the response includes `truncated: true` when a cap was hit.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `task_id` | string | yes | Task UUID |
| `repo` | string | no | Which of the task's repos to diff (defaults to the implementation PR) |
| `files_only` | boolean | no | Skip the unified diff and per-file patches — just filenames + add/delete stats |

### `get_task_review_thread`

A task's PR reviews, review comments, and issue comments merged into one chronological feed.
Capped at the 200 most recent items with each item's body capped at 5000 bytes — the response
includes `truncated: true` when a cap was hit.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `task_id` | string | yes | Task UUID |
| `repo` | string | no | Which of the task's repos to read (defaults to the implementation PR) |

### `get_feature_handoff`

A go-owned feature's handoff state — the multi-repo final-PR fan-out as it nears completion.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `feature_id` | string | yes | Feature UUID |

**Errors:** `{ ok: false, reason: "handoff_not_found: ..." }` if the feature isn't go-owned or has no handoff yet.

### `list_workspace_activity`

The audit/activity feed for a workspace, optionally filtered to one feature or task.
`audience: "client"` filters to a curated, human-friendly action set; omit for the full internal
feed (raw action codes, not all actor names resolved yet). Paginated — defaults to the 50 most
recent events, max 1000 per page.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `feature_id` / `task_id` | string | no | Restrict to one feature/task |
| `audience` | `"internal"` \| `"client"` | no | Filter action verbosity |
| `page` | number | no | Page number, 1-indexed (default 1) |
| `limit` | number | no | Page size (default 50, max 1000) |

### `list_workspace_repos`

Every repo registered in a workspace — id, url, default branch, whether it's the management repo,
and its tags.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |

### `read_storage_document`

Read a go-owned feature's document content from storage-service. Scoped to go-owned features
only — ts-owned feature documents remain git-backed.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `feature_id` | string | yes | Feature UUID |
| `kind` | `"product_spec"` \| `"technical_design"` \| `"tasks"` \| `"handoff"` | yes | Document kind to read |

**Errors:** `{ ok: false, reason: "document_not_found: ..." }` on 404.

### `list_workspace_documents`

List every document's metadata (id, path, `created_at`, `current_version_id`) in a workspace, or
in one feature via `feature_id`. No content — use `read_storage_document` for that. Response is
`{ documents: [...], truncated: boolean }` — defaults to at most 500 documents (max 2000).

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `feature_id` | string | no | Restrict to one feature (omit for workspace-wide) |
| `limit` | number | no | Max documents to return (default 500, max 2000) |

### `get_document_versions`

A document's edit history, newest first — `source` (edit/import/migration/restore) and timestamp
per version. Note: `author` is a raw user UUID, not a resolved display name. Response is
`{ versions: [...], truncated: boolean }` — defaults to at most 200 versions (max 1000).

| Field | Type | Required | Description |
|---|---|---|---|
| `document_id` | string | yes | Document UUID (from `list_workspace_documents`) |
| `limit` | number | no | Max versions to return (default 200, max 1000) |

### `whoami`

The authenticated caller's identity — profile, org memberships, and platform roles. No
`workspace_id`/`org_id` params. Useful for sanity-checking auth/org scope before calling
workspace-scoped tools.

## Development

```sh
pnpm run build        # compile TypeScript → dist/
pnpm run typecheck    # type-check without emitting
pnpm run lint         # lint src/
pnpm test             # run Jest tests
```

Or via `make` (see the `Makefile`): `make build` / `make typecheck` / `make lint` / `make test` /
`make run` (build + run the compiled server) / `make link` (build + `pnpm link --global`).

## Architecture

```
stdin/stdout (stdio MCP transport)
    │
    ▼
McpServer (MCP TS SDK)
    │
    ├── get_feature 
    ├── list_workspaces 
    ├── search_features 
    ├── search_tasks 
    ├── get_task 
    ├── get_task_diff 
    ├── get_task_review_thread 
    ├── get_feature_handoff 
    ├── list_workspace_activity
    ├── list_workspace_repos 
    ├── read_storage_document 
    ├── list_workspace_documents
    ├── get_document_versions 
    └── whoami 
```

When a bearer token is configured (`WORKFLOW_TOKEN` or the shared credential file), every request
carries `Authorization: Bearer <token>`. No DB credentials are held by this server, and
org/workspace access control is enforced entirely server-side (`workflow-bff`/`workflow-backend`
resolve the caller's accessible orgs from the token on every request) — this server never
bypasses it.
