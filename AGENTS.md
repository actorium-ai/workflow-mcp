# workflow-mcp — Agent Usage Guide

This MCP server lets agents create tasks for go-owned workflow features through the
workflow BFF API. It exposes two tools: `get_feature` and `create_tasks`.

## Prerequisites

1. The `workflow-mcp` binary is on your PATH (`npm link` after `npm run build`).
2. `WORKFLOW_BFF_URL` is set (or defaults to `http://localhost:8090`).
3. `WORKFLOW_SESSION_COOKIE` is set to a valid `session_id` cookie value.

## Tools

### `get_feature`

Resolve a feature by name before creating its tasks.

```
get_feature({ name: "workflow-db" })
// → { id: "550e8400-…", name: "workflow-db", title: "…", owner: "go", stage: "tasks" }
```

### `create_tasks`

Create all tasks for a feature in one bulk call.

```
create_tasks({
  feature_id: "550e8400-…",
  tasks: [
    { id: "T1", title: "Schema migration", repo: "workflow-backend", actor_type: "agent", depends_on: [] },
    { id: "T2", title: "Read API",         repo: "workflow-backend", actor_type: "agent", depends_on: ["T1"] },
  ]
})
// → { created: 2 }
```

### `unblock_task`

Unblock a blocked task. The resume state is derived server-side — no target choice needed.

```
unblock_task({
  workspace_id: "550e8400-…",
  feature: "executor-self-briefing",   // or UUID
  task: "T3",                          // or UUID
  note: "pushed the fixed image",      // optional
})
// success → { ok: true, from: "blocked", to: "ready" }
// not blocked → { ok: false, reason: "task_not_blocked" }
// wrong org → { ok: false, reason: "access_denied" }
```

`to` reflects where the server placed the task — `"ready"` (when blocked from `in_progress`)
or `"in_review"` (when blocked from `reviewing`/`in_review`).

## Typical create-tasks flow

```
1. Confirm the feature's tasks stage is approved.
2. get_feature({ name: "<feature>" })          → feature.id
3. Parse tasks.md index table                  → task list
4. create_tasks({ feature_id, tasks })         → { created: N }
5. Done — orchestrator picks up ready tasks.
```

## Typical unblock-task flow

```
1. Human resolves the external blocker (e.g. fixes the failing image, rebases the branch).
2. unblock_task({ workspace_id, feature: "<name>", task: "<name>", note: "<what was fixed>" })
3. Check { ok, from, to } — orchestrator picks up the resumed task automatically.
```

### `read_storage_document`

Read a `go`-owned feature's document from `storage-service`. Only applies to `go`-owned features.

```
read_storage_document({
  workspace_id: "550e8400-…",
  feature_id:   "660e8400-…",
  kind:         "product_spec",   // "product_spec" | "technical_design" | "tasks" | "handoff"
})
// success → raw markdown string, e.g. "# Product Spec\n..."
// not found → { ok: false, reason: "document_not_found: kind=\"product_spec\" in feature 660e8400-…" }
```

### `write_storage_document`

Create or import a markdown document into `storage-service` for a `go`-owned feature.

```
write_storage_document({
  workspace_id: "550e8400-…",
  feature_id:   "660e8400-…",
  kind:         "technical_design",
  content:      "# Technical Design\n...",
})
// success → { ok: true, id: "770e8400-…", kind: "technical_design", slug: "technical-design" }
```

## Storage document flow (go-owned features only)

```
1. Obtain workspace_id and feature_id (e.g. via get_feature).
2. write_storage_document({ workspace_id, feature_id, kind, content })   → creates the document.
3. read_storage_document({ workspace_id, feature_id, kind })             → reads it back.
```

`ts`-owned features are unaffected — their documents live in git and are accessed via the
Claude Code executor's standard clone-and-Read model.

## Auth

Set `WORKFLOW_SESSION_COOKIE` to the `session_id` value from a browser login session:

1. Log in to the workflow UI.
2. DevTools → Application → Cookies → copy `session_id` value.
3. Re-register: `claude mcp add workflow-mcp --scope local --env WORKFLOW_SESSION_COOKIE=<value> -- workflow-mcp`

A `401` response means the session has expired — repeat step 3.

## Conflict / failure-list handling

If `create_tasks` returns a `failures` array:

```json
{
  "error": "some tasks already exist",
  "failures": [{ "id": "T1", "reason": "already exists" }]
}
```

Options:
- **Stop** — abort and surface failures for manual resolution.
- **Retry** — resolve conflicts (e.g. delete existing tasks), then retry the full batch.
- **Skip-failing-and-retry-rest** — re-call `create_tasks` with only the non-failing tasks.

Always show the full failure list to the user before deciding.

## Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `WORKFLOW_BFF_URL` | `http://localhost:8090` | BFF base URL |
| `WORKFLOW_SESSION_COOKIE` | — | `session_id` cookie value |
