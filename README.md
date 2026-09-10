# actorium-mcp

MCP server for Actorium.
Gives a coding agent full context on features, tasks, PRs, activity, documents, and identity.
Mostly read-only, so it's safe to hand to an agent that only needs to *understand* a workspace —
the exceptions are the spec-review tools (`review_*`) and
`create_storage_document`/`update_storage_document`, which create or edit a go-owned feature's
documents.

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

Every storage-document tool below accepts either `kind` (the four canonical per-feature docs,
requires `feature_id`) or `path` (any other document — a non-canonical feature file, or a
workspace-root document with no owning feature at all, `feature_id` omitted). Pass exactly one.

### `read_storage_document`

Read a document's content from storage-service — a go-owned feature's canonical doc (via `kind`)
or any other document, including a workspace-root file with no owning feature (via `path`).
Scoped to storage-service-backed documents only — a go-owned feature's ts-owned siblings remain
git-backed.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `feature_id` | string | no | Feature UUID. Omit for a workspace-root document |
| `kind` | `"product_spec"` \| `"technical_design"` \| `"tasks"` \| `"handoff"` | one of kind/path | Canonical document kind; requires `feature_id` |
| `path` | string | one of kind/path | Explicit relative path, e.g. `"notes/design.md"` |

**Errors:** `{ ok: false, reason: "document_not_found: ..." }` on 404; `{ ok: false, reason: "invalid_args: ..." }` if kind/path aren't used correctly.

### `create_storage_document`

Create a document in storage-service, seeding its initial content in one call — a go-owned
feature's canonical doc (via `kind`) or any other document, including a workspace-root file with
no owning feature (via `path`, `feature_id` omitted). Create-or-get, not upsert: if a document at
this path already exists, the EXISTING document is returned unchanged — this never overwrites
existing content. Use `update_storage_document` to modify a document that already exists.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `feature_id` | string | no | Feature UUID. Omit for a workspace-root document |
| `kind` | `"product_spec"` \| `"technical_design"` \| `"tasks"` \| `"handoff"` | one of kind/path | Canonical document kind; requires `feature_id` |
| `path` | string | one of kind/path | Explicit relative path, e.g. `"notes/design.md"` |
| `content` | string | yes | Initial markdown content |

**Returns:** `{ id, path, version_id }`.

**Errors:** `{ ok: false, reason: "invalid_args: ..." }` if kind/path aren't used correctly.

### `update_storage_document`

Update an existing document's content in storage-service, creating a new version — a go-owned
feature's canonical doc (via `kind`) or any other document, including a workspace-root file with
no owning feature (via `path`, `feature_id` omitted). Edit-only — 404s with
`document_not_found` if no document at this path exists yet; call `create_storage_document`
first.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `feature_id` | string | no | Feature UUID. Omit for a workspace-root document |
| `kind` | `"product_spec"` \| `"technical_design"` \| `"tasks"` \| `"handoff"` | one of kind/path | Canonical document kind; requires `feature_id` |
| `path` | string | one of kind/path | Explicit relative path, e.g. `"notes/design.md"` |
| `content` | string | yes | New markdown content, replacing the current version |

**Returns:** `{ ok: true, version_id }`.

**Errors:** `{ ok: false, reason: "document_not_found: ..." }` on 404; `{ ok: false, reason: "invalid_args: ..." }` if kind/path aren't used correctly.

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

### `update_feature_stage`

Approve, reject, or reopen a feature's current review stage — the same action the
digital-factory-ui Approval card performs (Approve / Reject / Re-open buttons). This is a
**human-directed** action: only call it when a human has explicitly asked to approve, reject, or
reopen a *specific* stage; confirm the stage/action with the human first if there's any ambiguity.
Calls hermes-agent's existing `stage-transition` endpoint through the BFF — no transition logic
(the `(stage, action) → feature_status/current_stage/next_action` mapping) is reimplemented here;
it's computed entirely server-side in hermes-agent, the same code path the web app's Approval card
uses.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `feature_id` | string | yes | Feature UUID (from `search_features`/`get_feature`) |
| `stage` | `"product_spec"` \| `"technical_design"` \| `"tasks"` \| `"handoff"` | yes | Which lifecycle stage to act on |
| `action` | `"approve"` \| `"reject"` \| `"reopen"` | yes | Action to perform |
| `comment` | string | no | Optional comment recorded with a reject or reopen action |

**Returns:** `{ ok, feature_id, stage, action, review_status, feature_status, current_stage, commit_sha, branch, activated_tasks }`. For `stage="tasks"` approve, also activates tasks (`activated_tasks`).

**Errors:** `{ ok: false, reason: "needs_status_change", target_status: "in_design", ... }` when the
feature is still in `backlog` — not a true failure, relay it to the human rather than retrying;
standard `401`/other-BFF-error messages otherwise.

### `create_feature`

Creates a new feature in a workspace — same effect as the Board modal's "New feature", or
workflow-chat-agent's `workflow_init_feature` tool. Always sends `owner: "go"`; this is the only
supported orchestrator type for MCP-initiated creation. `POST .../workspaces/:workspaceId/features`.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `name` | string | yes | Feature name — must be unique within the workspace |
| `description` | string | no | Optional feature description |
| `start_stage` | string | no | Optional starting lifecycle stage, if supported by the backend |

**Returns:** `{ feature_id, init_pr_url, owner: "go" }`. Continue immediately with
`create_storage_document` (`kind: "product_spec"`) against the new `feature_id`.

### `move_feature_status`

Moves a feature out of Backlog into In Design — the *only* transition this tool performs (mirrors
workflow-chat-agent's `move_feature_status`). Human-directed: only call it when asked to
move/advance a feature. Reads the feature's current status first; anything other than exactly
`backlog` is a safe no-op, not an error.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `feature_id` | string | yes | Feature UUID |
| `actor` | string | no | Label recorded for this transition; defaults to your account label |

**Returns:** `{ ok: true, action: "moved" | "noop", feature_id, feature_status, ... }`.

### `create_tasks`

Bulk-creates DB task rows for a feature — `POST .../features/:featureId/tasks`. This is the
backup/manual-trigger path for "step d" of the tasks-stage approve pipeline: use it when
`update_feature_stage(stage="tasks", action="approve")` has already promoted the feature and merged
its docs PR, but task creation itself needs a retry. It does **only** task creation — never
promotion, docs-PR merge, or feature-status updates.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `feature_id` | string | yes | Feature UUID |
| `tasks` | array | yes | `{ id, title, repo?, depends_on?, actor_type?, model? }[]`, as parsed from the feature's approved `tasks.md` |

**Errors:** `{ ok: true, noop: true }` if tasks already exist (safe no-op, HTTP 409 from the
backend); `feature_not_tasks_approved` if the tasks stage isn't approved yet.

### `vcs_pr_context`

Read-only GitHub PR context, routed through vcs-service (no `GITHUB_TOKEN` needed) — a single tool
with an `action` selector, mirroring workflow-chat-agent's `github_pr_context`.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID (used to resolve the repo's registered `vcs_connection_id`) |
| `action` | `"diff"` \| `"files"` \| `"metadata"` \| `"comments"` \| `"reviews"` \| `"checks"` \| `"commits"` \| `"compare"` \| `"file_at_ref"` \| `"list_prs"` | yes | Operation to perform |
| `pr_url` | string | for PR-scoped actions | `https://github.com/{owner}/{repo}/pull/{number}` |
| `owner`, `repo` | string | for `compare`/`file_at_ref`/`list_prs` | Inferred from `pr_url` otherwise |
| `base`, `head` | string | for `compare` | Refs/branches/SHAs to compare |
| `path`, `ref` | string | for `file_at_ref` | File path and ref to read |
| `state` | `"open"` \| `"closed"` \| `"all"` | no | PR state filter for `list_prs` (default `open`) |

### `vcs_pr_diff` / `vcs_pr_files`

Single-purpose counterparts to `vcs_pr_context(action="diff"|"files")`, for a model reaching for
"what changed in this PR" without reasoning about the full action enum.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `pr_url` | string | yes | `https://github.com/{owner}/{repo}/pull/{number}` |

### `vcs_pr_review`

Posts a GitHub PR review via the two-call pattern: an issue comment carries the full narrative
first (always visible, never subject to self-review restriction), then a formal review event is
attempted. A `422` on the review event (GitHub blocking self-review) is not a failure — the tool
still returns `ok: true` with `self_review_skipped: true`, and the issue comment stands as the
authoritative narrative.

| Field | Type | Required | Description |
|---|---|---|---|
| `workspace_id` | string | no | Workspace UUID |
| `pr_url` | string | yes | GitHub PR URL |
| `event` | `"APPROVE"` \| `"REQUEST_CHANGES"` | yes | Review verdict |
| `body` | string | yes | Full review narrative |
| `comments` | array | no | `{ path, line, body }[]` inline comments on the formal review event |

**Returns:** `{ ok: true, review_url, self_review_skipped }`.

### `vcs_create_pr` / `vcs_ensure_branch` / `vcs_commit_files`

Write operations against a repo, all routed through vcs-service (which resolves a scoped GitHub
App installation token per-repo — no `GITHUB_TOKEN` needed here). Typical order when a branch
doesn't exist yet: `vcs_ensure_branch` → `vcs_commit_files` → `vcs_create_pr`.

| Tool | Required fields | Notes |
|---|---|---|
| `vcs_create_pr` | `owner`, `repo`, `title`, `head`, `base` | `body`, `draft` optional. Returns `{ number, html_url, state, head_ref, base_ref }` |
| `vcs_ensure_branch` | `owner`, `repo`, `branch`, `base_branch` | Creates `branch` from `base_branch` only if it doesn't already exist on the remote |
| `vcs_commit_files` | `owner`, `repo`, `branch`, `message`, `files` | `files` is a path → full-content map (GitHub Contents API — not a diff/patch); `base_branch` optional, to create `branch` first |

All three accept an optional `workspace_id` (used the same way as `vcs_pr_context`, to resolve
`vcs_connection_id`).

### `whoami`

The authenticated caller's identity — profile, org memberships, and platform roles. No
`workspace_id`/`org_id` params. Useful for sanity-checking auth/org scope before calling
workspace-scoped tools.

### `review_start`

Starts a spec review between hermes and this local agent on a feature — `POST /reviews`.
Replaces the web "Start review" modal: since this runs from inside the MCP server itself,
the presence lease the server checks is necessarily live.

| Field | Type | Required | Description |
|---|---|---|---|
| `feature_id` | string | yes | Feature UUID to review |
| `initial_prompt` | string | yes | What to review — seeds both participants |
| `hermes_model_id` | string | yes | Model catalog id for hermes |
| `workspace_id` | string | no | Defaults to the linked workspace this server runs for |
| `first_responder` | string | no | `"hermes"` or this agent; defaults to this agent (reviewer-first) |
| `allow_broader_code_quoting` | boolean | no | Let this agent quote code from outside its working directory; confirm with the human first. Defaults to false |

**Errors:** `{ ok: false, reason: "not_logged_in" }` when there's no usable login; `{ ok: false, reason: "session_expired" }` on a 401 from the server.

### `review_get_turn`

Polls `GET /participants/{id}/pending-turn` for a review turn owed to this agent — the
server is the source of truth, never the local SSE buffer. A `pending: false` response is
enriched with an explicit wait hint (or a "stop, ask the human" hint when the review is
blocked on a human answer, or "review has ended" once it's over).

### `review_submit_reply`

Posts `{ content }` to `POST /threads/{session_id}/messages`; the author is derived
server-side from the signed identity header, not sent by the client.

| Field | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Review session UUID owed a turn by this agent |
| `content` | string | yes | Reply text |

### `review_end`

Ends the review: `POST /reviews/{session_id}/end`. The transcript is preserved — this
stops the exchange, it does not delete it.

| Field | Type | Required | Description |
|---|---|---|---|
| `session_id` | string | yes | Review session UUID to end |
| `reason` | string | no | Defaults to `"reviewer_satisfied"` |

## Tutorial: driving a feature end-to-end, like workflow-chat-agent

workflow-chat-agent (the "chat-agent" backing digital-factory-ui's chat) drives every feature
through the same lifecycle: **Backlog → In Design → In TDD → In Tasks → In Implementation → Done**,
gated by four review stages (`product_spec`, `technical_design`, `tasks`, `handoff`). Each stage is
drafted, then a human approves/rejects/reopens it before the feature can advance. The tools above
are the same primitives chat-agent's own tools (`workflow_init_feature`, `write_product_spec`,
`approve_feature`, `write_tasks`, the `vcs_*` tools, ...) call under the hood — this walks through
driving that exact flow from an MCP client (Claude Code, another agent, or a script).

```
create_feature
      │  owner: "go", status: backlog
      ▼
create_storage_document(kind="product_spec")  ──┐
      │                                          │  drafting loop: update_storage_document
      ▼                                          │  to revise before/after review
update_feature_stage(stage="product_spec", action="approve")
      │  needs_status_change if still "backlog" ─┘
      ▼
move_feature_status               (backlog → in_design, only if needed)
      │
      ▼
create_storage_document(kind="technical_design")
      ▼
update_feature_stage(stage="technical_design", action="approve")
      │  status → in_tdd
      ▼
create_storage_document(kind="tasks")           (tasks.md: index table + per-task sections)
      ▼
update_feature_stage(stage="tasks", action="approve")
      │  status → in_tasks; activates tasks server-side (activated_tasks)
      │  (backup path if creation didn't take: create_tasks)
      ▼
search_tasks / get_task                          (poll task status as implementation proceeds)
      │
      ▼
vcs_ensure_branch → vcs_commit_files → vcs_create_pr     (per task, if driving implementation directly)
      ▼
vcs_pr_context / vcs_pr_diff / vcs_pr_files      (gather context to review a task's PR)
      ▼
vcs_pr_review(event="APPROVE" | "REQUEST_CHANGES")
      ▼
update_feature_stage(stage="handoff", action="approve")     (go-owned features only)
      │  status → done
```

### Step by step

1. **Create the feature.**
   ```
   create_feature(name="checkout-retry-logic", description="Retry failed payment webhooks")
   → { feature_id: "…", init_pr_url: "…", owner: "go" }
   ```
   The feature starts in `status: "backlog"`, `current_stage: "product_spec"`.

2. **Draft and approve the product spec.**
   ```
   create_storage_document(feature_id, kind="product_spec", content="# Product Spec\n…")
   update_feature_stage(feature_id, stage="product_spec", action="approve")
   ```
   If the feature is still in Backlog, `update_feature_stage` returns
   `{ ok: false, reason: "needs_status_change", target_status: "in_design" }` instead of approving —
   relay that to the human, then call `move_feature_status` (or have them click "Move to In Design"
   in the UI) and retry the approve.

3. **Draft and approve the technical design**, the same way, with `kind="technical_design"`.
   Use `get_feature` first to pull the approved product spec back in as context — its
   `documents`/`tasks`/`activity` are all bundled in one call.

4. **Write the task breakdown and approve it.** Write a `tasks.md` (index table + one section per
   task) via `create_storage_document(kind="tasks")` — chat-agent's own `write_tasks` tool adds
   heavier validation here (GitNexus-verified repo names, skill/model resolution) that this MCP
   server does not reimplement; keep task `repo` values accurate by hand, or cross-check with
   `list_workspace_repos`. Then:
   ```
   update_feature_stage(feature_id, stage="tasks", action="approve")
   ```
   This both approves the stage and activates tasks server-side (`activated_tasks` in the
   response). If task rows don't show up (a partial failure), retry with `create_tasks` — it's
   idempotent (`tasks_already_exist` comes back as a safe no-op).

5. **Track implementation.** Poll `search_tasks(feature_id)` / `get_task(task_id)` for status,
   branch, and PR fields. If you (the calling agent) are driving implementation directly rather
   than a separate executor, use `vcs_ensure_branch` → `vcs_commit_files` → `vcs_create_pr` per
   task.

6. **Review task PRs.** `vcs_pr_context` (or the single-purpose `vcs_pr_diff`/`vcs_pr_files`) to
   gather context, then `vcs_pr_review` to post a verdict — the two-call pattern means your
   narrative lands as a comment even if GitHub blocks the formal review event for self-review.

7. **Handoff and done.** For a go-owned feature nearing completion, `get_feature_handoff` reports
   the multi-repo final-PR fan-out; `update_feature_stage(stage="handoff", action="approve")` closes
   it out to `status: "done"`.

Throughout, `list_workspace_activity` gives the audit trail (who did what, when) and
`list_workspace_documents` / `get_document_versions` let you inspect document history without
re-reading full content.

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
    ├── create_storage_document 
    ├── update_storage_document 
    ├── list_workspace_documents
    ├── get_document_versions 
    ├── update_feature_stage 
    ├── whoami
    ├── review_start
    ├── review_get_turn
    ├── review_submit_reply
    └── review_end
    │
    ▼ (review_* only, plus a background channel started alongside the server)
workflow-chat-agent, via workflow-bff's /bff/hermes-agent/api/v1/*
```

When a bearer token is configured (`WORKFLOW_TOKEN` or the shared credential file), every request
carries `Authorization: Bearer <token>`. No DB credentials are held by this server, and
org/workspace access control is enforced entirely server-side (`workflow-bff`/`workflow-backend`
resolve the caller's accessible orgs from the token on every request) — this server never
bypasses it.

The same access token backs a second thing, started automatically alongside the MCP server
(see `channel.ts`): a presence heartbeat (`POST .../participants/{id}/presence` every 30s)
and an SSE subscription (`GET .../participants/{id}/events`, wake-hints only) to
workflow-chat-agent. `{id}` is the `agent_participant_id` claim already embedded in the
access token's JWT — the same identity used to derive `first_responder`/message authorship
in the `review_*` tools above. If there's no usable login, `startChannel` is a clean no-op
(no timers, no connections) and the server warns on stderr.
