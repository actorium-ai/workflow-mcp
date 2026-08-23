# actorium-mcp — Agent Usage Guide

MCP server giving agents full context on the workflow platform: features (with bundled
docs/tasks/activity), tasks (PR diffs, review threads, execution info), documents, and caller
identity. Mostly read-only — the exceptions are the paired-agent spec-review tools (`review_*`)
and `create_storage_document`/`update_storage_document`, which create or edit a go-owned
feature's documents in storage-service; everything else only reads state.

## Prerequisites

1. The `actorium-mcp` binary is on your PATH (`pnpm link --global` after `pnpm run build`).
2. `API_URL` is set (or defaults to `http://localhost:8090`).
3. Auth is resolved automatically if you're signed in to the Actorium VS Code extension —
   see Auth below. Otherwise set `WORKFLOW_TOKEN`.

All tools below take an optional `workspace_id` (`list_workspaces` takes `org_id` instead) —
omit it to use the resolved default (see "Default workspace/org resolution" under Auth below).

## Tools

### `get_feature` — the main entry point

Resolve a feature by name and get everything about it in one call.

```
get_feature({ name: "workflow-db" })
// → { id, feature_name, title, status, current_stage, owner, workspace_id,
//     task_counts, documents: [...], tasks: [...], activity: [...] (capped at 50), source_state }
```

### `list_workspaces` / `search_features` / `search_tasks`

```
list_workspaces({ org_id })                                          → workspace summaries
search_features({ workspace_id, status?, title?, include_tasks?, limit? })   → paged feature list (limit default 50, max 1000)
search_tasks({ workspace_id, feature_id?, status?, repo?, limit? })          → paged task list (workspace-wide if feature_id omitted; limit default 50, max 1000)
```

### `get_task` / `get_task_diff` / `get_task_review_thread`

```
get_task({ task_id })              → execution info, both PR refs, per-task activity (capped at 50), depends_on
get_task_diff({ task_id, repo?, files_only? })
// → PR file list + unified diff (empty if no PR yet); size-capped, truncated:true if cut
// files_only:true skips the diff/patch content entirely (just filenames + stats)
get_task_review_thread({ task_id, repo? })
// → reviews + review comments + issue comments, chronological; capped at 200 items, 5000
//   bytes/body, truncated:true if cut
```

### `get_feature_handoff` / `list_workspace_activity` / `list_workspace_repos`

```
get_feature_handoff({ feature_id })    → go-owned features only; 404 if none/not go-owned
list_workspace_activity({ feature_id?, task_id?, audience?, page?, limit? })
// → audit trail; audience: "client" | "internal"; paginated, default limit 50, max 1000
list_workspace_repos({ workspace_id }) → repo id/url/default branch/tags, which is the management repo
```

### `read_storage_document` / `list_workspace_documents` / `get_document_versions`

Every storage-document tool accepts either `kind` (the four canonical per-feature docs, requires
`feature_id`) or `path` (any other document — a non-canonical feature file, or a workspace-root
document with no owning feature at all, `feature_id` omitted). Pass exactly one.

```
read_storage_document({ feature_id, kind })
// kind: "product_spec" | "technical_design" | "tasks" | "handoff" — canonical per-feature docs
// success → raw markdown string
// not found → { ok: false, reason: "document_not_found: kind=\"product_spec\" in feature ..." }

read_storage_document({ path })
// no feature_id → workspace-root document, e.g. one uploaded outside any feature's folder
// (pass feature_id alongside path to read a non-canonical file scoped to one feature instead)
// success → raw markdown string
// not found → { ok: false, reason: "document_not_found: path=\"shared/notes.md\" in workspace root" }

list_workspace_documents({ feature_id?, limit? })
// → { documents: [...], truncated } — metadata only (id, path, created_at), no content;
//   limit default 500, max 2000
get_document_versions({ document_id, limit? })
// → { versions: [...], truncated } — edit history, newest first (author is a raw user UUID);
//   limit default 200, max 1000
```

`ts`-owned features' canonical documents remain git-backed and are unaffected by these tools —
access them via the Claude Code executor's standard clone-and-Read model instead.

### `create_storage_document` / `update_storage_document`

Same `kind`-or-`path` choice as `read_storage_document` above.

```
create_storage_document({ feature_id, kind, content })          // canonical per-feature doc
create_storage_document({ path, content })                      // workspace-root document
create_storage_document({ feature_id, path, content })          // non-canonical feature file
// create-or-get, NOT upsert: if a document at this path already exists, the EXISTING
// document is returned unchanged (never overwrites it) — use update_storage_document instead
// success → { id, path, version_id }

update_storage_document({ feature_id, kind, content })
update_storage_document({ path, content })                      // workspace-root document
// edit-only: 404s with document_not_found if no document at this path exists yet —
// call create_storage_document first
// success → { ok: true, version_id }
```

### `whoami`

No params. Returns the caller's profile + org memberships + platform roles — sanity-check your
auth/org scope before calling workspace-scoped tools.

## Typical "understand this feature" flow

```
1. get_feature({ name: "<feature>" })         → status, docs, tasks, activity — all in one call
2. get_task({ task_id })                       → per-task PR refs + execution detail
3. get_task_diff / get_task_review_thread      → what changed, what feedback it's gotten
4. read_storage_document({ feature_id, kind }) → the actual spec/design/tasks content
```

## Auth

No manual setup needed if you're signed in to the **Actorium VS Code extension** — it writes a
shared credential file (`~/.actorium/auth.json`) on connect/switch-workspace/disconnect, and this
server reads it automatically (sent as `Authorization: Bearer`).

A `401` response means that token expired — run **Actorium: Connect** in VS Code to refresh it.

Without the extension (headless/CI), set `WORKFLOW_TOKEN` to a bearer JWT instead:
`claude mcp add actorium-mcp --scope local --env WORKFLOW_TOKEN=<jwt> -- actorium-mcp`.
There's no read/write token split — every tool here is a GET.

### Default workspace/org resolution

`workspace_id`/`org_id` fall back in this order when a tool call omits them:

1. **The workspace manifest** — `.actorium/workspace.json`, written by the extension at a linked
   workspace folder's root. This server walks upward from its own cwd looking for it, so it
   resolves the workspace it's running for directly from the folder it's in — correct even with
   multiple VS Code windows open on different workspaces at once.
2. Otherwise, the shared credential file's stored `workspace_id`/`org_id` — a single machine-wide
   "last selected" value, only a reasonable default when running from outside any linked
   workspace folder.

An explicit `workspace_id`/`org_id` argument always wins over both.

## Configuration reference

| Env var | Default | Purpose                                           |
|---|---|---------------------------------------------------|
| `API_URL` | `http://localhost:8090` | API URL                                           |
| `WORKFLOW_TOKEN` | — | Bearer JWT — overrides the shared credential file |
