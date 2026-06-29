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

## Typical create-tasks flow

```
1. Confirm the feature's tasks stage is approved.
2. get_feature({ name: "<feature>" })          → feature.id
3. Parse tasks.md index table                  → task list
4. create_tasks({ feature_id, tasks })         → { created: N }
5. Done — orchestrator picks up ready tasks.
```

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
