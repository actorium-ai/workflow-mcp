import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BffClient, BffAuthError, BffRequestError } from './bffClient.js';
import { Config } from './config.js';
import { sessionExpiredResult } from './mcpErrors.js';
import { WORKSPACE_ID_DESCRIPTION, resolveWorkspaceId } from './tools.js';

/**
 * GitHub PR/repo tools, proxied through vcs-service (`/bff/vcs-service/*`) —
 * vcs-service resolves a scoped GitHub App installation token per-repo
 * internally, so none of these tools need a GITHUB_TOKEN of their own.
 * Mirrors workflow-chat-agent's vcs_pr_context / vcs_pr_diff / vcs_pr_files /
 * vcs_pr_review / vcs_create_pr / vcs_ensure_branch / vcs_commit_files tools
 * (plugins/tools/*.py, plugins/clients/vcs_client.py).
 */

const VCS_PREFIX = '/bff/vcs-service/api/vcs';
const WORKFLOW_BACKEND_PREFIX = '/bff/workflow-backend/api';

type ToolResult = CallToolResult;

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }], isError: true };
}

function formatBffError(err: unknown): ToolResult {
  if (err instanceof BffAuthError) return sessionExpiredResult(err.message);
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(message);
}

const PR_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export function parsePrUrl(prUrl: string): { owner: string; repo: string; pullNumber: number } | { error: string } {
  const m = PR_URL_RE.exec(prUrl.trim());
  if (!m) {
    return { error: `Invalid GitHub PR URL "${prUrl}". Expected https://github.com/{owner}/{repo}/pull/{number}.` };
  }
  return { owner: m[1], repo: m[2], pullNumber: Number(m[3]) };
}

const GITHUB_URL_RE = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/;

interface WorkspaceRepoRow {
  repo_url?: string;
  vcs_connection_id?: string;
  [key: string]: unknown;
}

/**
 * Resolves the vcs_connection_id registered for owner/repo in a workspace, by
 * matching each workspace repo's `repo_url` — never raises; returns undefined
 * (fall back to vcs-service's own owner-based resolution) on any lookup
 * failure or when no row matches. Mirrors workflow-chat-agent's
 * `resolve_connection_id` / `get_repo_connection_id`.
 */
export async function resolveConnectionId(
  workspaceId: string,
  owner: string,
  repo: string,
  bffClient: BffClient,
): Promise<string | undefined> {
  try {
    const response = await bffClient.get<{ success: boolean; data: WorkspaceRepoRow[] }>(
      `${WORKFLOW_BACKEND_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/repos`,
    );
    const rows = response.data ?? [];
    const target = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    for (const row of rows) {
      const m = GITHUB_URL_RE.exec((row.repo_url ?? '').trim());
      if (m && `${m[1].toLowerCase()}/${m[2].toLowerCase()}` === target) {
        return row.vcs_connection_id || undefined;
      }
    }
  } catch {
    // Unavailable/misconfigured — callers fall back to owner-based resolution.
  }
  return undefined;
}

async function postVcs<T>(
  bffClient: BffClient,
  path: string,
  payload: Record<string, unknown>,
  connectionId: string | undefined,
): Promise<T> {
  return bffClient.post<T>(`${VCS_PREFIX}${path}`, connectionId ? { ...payload, connection_id: connectionId } : payload);
}

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true };
const WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true };

// ── vcs_pr_context ───────────────────────────────────────────────────────────

const PR_CONTEXT_ACTIONS = [
  'diff',
  'files',
  'metadata',
  'comments',
  'reviews',
  'checks',
  'commits',
  'compare',
  'file_at_ref',
  'list_prs',
] as const;
type PrContextAction = (typeof PR_CONTEXT_ACTIONS)[number];
const PR_SCOPED_ACTIONS = new Set<PrContextAction>([
  'diff',
  'files',
  'metadata',
  'comments',
  'reviews',
  'checks',
  'commits',
]);

interface PrMetadata {
  head_sha?: string;
  [key: string]: unknown;
}

export interface VcsPrContextArgs {
  action: PrContextAction;
  pr_url?: string;
  owner?: string;
  repo?: string;
  base?: string;
  head?: string;
  path?: string;
  ref?: string;
  state?: 'open' | 'closed' | 'all';
}

export async function handleVcsPrContext(
  args: VcsPrContextArgs,
  workspaceId: string,
  bffClient: BffClient,
): Promise<ToolResult> {
  const { action, base, head, path, ref, state } = args;
  let owner = args.owner ?? '';
  let repo = args.repo ?? '';
  let pullNumber: number | undefined;

  if (PR_SCOPED_ACTIONS.has(action)) {
    if (!args.pr_url) return errorResult(`pr_url is required for action="${action}".`);
    const parsed = parsePrUrl(args.pr_url);
    if ('error' in parsed) return errorResult(parsed.error);
    owner = parsed.owner;
    repo = parsed.repo;
    pullNumber = parsed.pullNumber;
  }

  const connectionId = owner && repo ? await resolveConnectionId(workspaceId, owner, repo, bffClient) : undefined;

  try {
    switch (action) {
      case 'diff': {
        const data = await postVcs<{ diff?: string }>(bffClient, '/pr/diff', { owner, repo, number: pullNumber }, connectionId);
        return jsonResult({ ok: true, diff: data.diff ?? data });
      }
      case 'files': {
        const data = await postVcs<{ files?: unknown }>(bffClient, '/pr/files', { owner, repo, number: pullNumber }, connectionId);
        return jsonResult({ ok: true, files: data.files ?? data });
      }
      case 'metadata': {
        const data = await postVcs<PrMetadata>(bffClient, '/pr/metadata', { owner, repo, number: pullNumber }, connectionId);
        return jsonResult({ ok: true, metadata: data });
      }
      case 'comments': {
        const data = await postVcs<Record<string, unknown>>(
          bffClient,
          '/pr/comments',
          { owner, repo, number: pullNumber },
          connectionId,
        );
        return jsonResult({ ok: true, ...data });
      }
      case 'reviews': {
        const data = await postVcs<{ reviews?: unknown }>(
          bffClient,
          '/pr/review_history',
          { owner, repo, number: pullNumber },
          connectionId,
        );
        return jsonResult({ ok: true, reviews: data.reviews ?? data });
      }
      case 'checks': {
        const meta = await postVcs<PrMetadata>(bffClient, '/pr/metadata', { owner, repo, number: pullNumber }, connectionId);
        if (!meta.head_sha) return errorResult('Could not determine head SHA from PR metadata.');
        const data = await postVcs<Record<string, unknown>>(
          bffClient,
          '/pr/checks',
          { owner, repo, head_sha: meta.head_sha },
          connectionId,
        );
        return jsonResult({ ok: true, ...data });
      }
      case 'commits': {
        const data = await postVcs<{ commits?: unknown }>(
          bffClient,
          '/pr/commits',
          { owner, repo, number: pullNumber },
          connectionId,
        );
        return jsonResult({ ok: true, commits: data.commits ?? data });
      }
      case 'compare': {
        if (!owner || !repo) return errorResult("owner and repo are required for action='compare'.");
        if (!base || !head) return errorResult("base and head are required for action='compare'.");
        const data = await postVcs<Record<string, unknown>>(bffClient, '/repo/compare', { owner, repo, base, head }, connectionId);
        return jsonResult({ ok: true, ...data });
      }
      case 'file_at_ref': {
        if (!owner || !repo) return errorResult("owner and repo are required for action='file_at_ref'.");
        if (!path) return errorResult("path is required for action='file_at_ref'.");
        if (!ref) return errorResult("ref is required for action='file_at_ref'.");
        const data = await postVcs<Record<string, unknown>>(
          bffClient,
          '/repo/file_content',
          { owner, repo, path, ref },
          connectionId,
        );
        return jsonResult({ ok: true, ...decodeFileContent(data) });
      }
      case 'list_prs': {
        if (!owner || !repo) return errorResult("owner and repo are required for action='list_prs'.");
        const payload: Record<string, unknown> = { owner, repo, state: state ?? 'open' };
        if (head) payload.head = head;
        const data = await postVcs<{ pull_requests?: unknown }>(bffClient, '/pr/list', payload, connectionId);
        return jsonResult({ ok: true, pull_requests: data.pull_requests ?? data });
      }
      default:
        return errorResult(`Unknown action "${action}".`);
    }
  } catch (err) {
    return formatBffError(err);
  }
}

function decodeFileContent(data: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(data)) return { ok: false, error: 'Path is a directory, not a file.' };
  const raw = (data.content as string) ?? '';
  let content = raw;
  if (data.encoding === 'base64' && raw) {
    try {
      content = Buffer.from(raw, 'base64').toString('utf-8');
    } catch {
      content = raw;
    }
  }
  return { ...data, content };
}

// ── vcs_pr_diff / vcs_pr_files ───────────────────────────────────────────────

export async function handleVcsPrDiff(pr_url: string, workspaceId: string, bffClient: BffClient): Promise<ToolResult> {
  const parsed = parsePrUrl(pr_url);
  if ('error' in parsed) return errorResult(parsed.error);
  const connectionId = await resolveConnectionId(workspaceId, parsed.owner, parsed.repo, bffClient);
  try {
    const data = await postVcs<{ diff?: string }>(
      bffClient,
      '/pr/diff',
      { owner: parsed.owner, repo: parsed.repo, number: parsed.pullNumber },
      connectionId,
    );
    return jsonResult({ ok: true, diff: data.diff ?? data });
  } catch (err) {
    return formatBffError(err);
  }
}

export async function handleVcsPrFiles(pr_url: string, workspaceId: string, bffClient: BffClient): Promise<ToolResult> {
  const parsed = parsePrUrl(pr_url);
  if ('error' in parsed) return errorResult(parsed.error);
  const connectionId = await resolveConnectionId(workspaceId, parsed.owner, parsed.repo, bffClient);
  try {
    const data = await postVcs<{ files?: unknown }>(
      bffClient,
      '/pr/files',
      { owner: parsed.owner, repo: parsed.repo, number: parsed.pullNumber },
      connectionId,
    );
    return jsonResult({ ok: true, files: data.files ?? data });
  } catch (err) {
    return formatBffError(err);
  }
}

// ── vcs_pr_review ────────────────────────────────────────────────────────────

export interface VcsPrReviewArgs {
  pr_url: string;
  event: 'APPROVE' | 'REQUEST_CHANGES';
  body: string;
  comments?: { path: string; line: number; body: string }[];
}

interface IssueCommentResponse {
  html_url?: string;
}

interface PrReviewResponse {
  html_url?: string;
}

/**
 * Posts a GitHub PR review via the two-call pattern: an issue comment carries
 * the full narrative (always visible, never subject to self-review
 * restriction), then a formal review event is attempted — a 422 there (GitHub
 * blocking self-review) is not a failure, it makes the issue comment the
 * authoritative narrative (`self_review_skipped: true`).
 */
export async function handleVcsPrReview(
  args: VcsPrReviewArgs,
  workspaceId: string,
  bffClient: BffClient,
): Promise<ToolResult> {
  const parsed = parsePrUrl(args.pr_url);
  if ('error' in parsed) return errorResult(parsed.error);
  const { owner, repo, pullNumber } = parsed;
  const connectionId = await resolveConnectionId(workspaceId, owner, repo, bffClient);

  let commentUrl = '';
  try {
    const comment = await postVcs<IssueCommentResponse>(
      bffClient,
      '/pr/issue_comment',
      { owner, repo, number: pullNumber, body: args.body },
      connectionId,
    );
    commentUrl = comment.html_url ?? '';
  } catch (err) {
    if (err instanceof BffAuthError) return sessionExpiredResult(err.message);
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to post issue comment (step 1): ${message}`);
  }

  try {
    const review = await postVcs<PrReviewResponse>(
      bffClient,
      '/pr/reviews',
      { owner, repo, number: pullNumber, event: args.event, body: args.body, ...(args.comments ? { comments: args.comments } : {}) },
      connectionId,
    );
    return jsonResult({ ok: true, review_url: review.html_url ?? '', self_review_skipped: false });
  } catch (err) {
    if (err instanceof BffRequestError && err.status === 422) {
      return jsonResult({ ok: true, review_url: commentUrl, self_review_skipped: true });
    }
    if (err instanceof BffAuthError) return sessionExpiredResult(err.message);
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to post review event (step 2): ${message}`);
  }
}

// ── vcs_create_pr / vcs_ensure_branch / vcs_commit_files ────────────────────

export interface VcsCreatePrArgs {
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

export async function handleVcsCreatePr(
  args: VcsCreatePrArgs,
  workspaceId: string,
  bffClient: BffClient,
): Promise<ToolResult> {
  const connectionId = await resolveConnectionId(workspaceId, args.owner, args.repo, bffClient);
  try {
    const data = await postVcs<{
      number?: number;
      html_url?: string;
      state?: string;
      head_ref?: string;
      base_ref?: string;
    }>(
      bffClient,
      '/pr/create',
      {
        owner: args.owner,
        repo: args.repo,
        title: args.title,
        head: args.head,
        base: args.base,
        body: args.body ?? '',
        draft: !!args.draft,
      },
      connectionId,
    );
    return jsonResult({
      ok: true,
      number: data.number,
      html_url: data.html_url,
      state: data.state,
      head_ref: data.head_ref,
      base_ref: data.base_ref,
    });
  } catch (err) {
    return formatBffError(err);
  }
}

export interface VcsEnsureBranchArgs {
  owner: string;
  repo: string;
  branch: string;
  base_branch: string;
}

export async function handleVcsEnsureBranch(
  args: VcsEnsureBranchArgs,
  workspaceId: string,
  bffClient: BffClient,
): Promise<ToolResult> {
  const connectionId = await resolveConnectionId(workspaceId, args.owner, args.repo, bffClient);
  try {
    await postVcs(
      bffClient,
      '/repo/ensure_branch',
      { owner: args.owner, repo: args.repo, branch: args.branch, base_branch: args.base_branch },
      connectionId,
    );
    return jsonResult({ ok: true, branch: args.branch });
  } catch (err) {
    return formatBffError(err);
  }
}

export interface VcsCommitFilesArgs {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  files: Record<string, string>;
  base_branch?: string;
}

export async function handleVcsCommitFiles(
  args: VcsCommitFilesArgs,
  workspaceId: string,
  bffClient: BffClient,
): Promise<ToolResult> {
  if (Object.keys(args.files).length === 0) return errorResult('files is required and must not be empty.');
  const connectionId = await resolveConnectionId(workspaceId, args.owner, args.repo, bffClient);
  try {
    await postVcs(
      bffClient,
      '/repo/commit_files',
      {
        owner: args.owner,
        repo: args.repo,
        branch: args.branch,
        message: args.message,
        files: args.files,
        ...(args.base_branch ? { base_branch: args.base_branch } : {}),
      },
      connectionId,
    );
    return jsonResult({ ok: true, branch: args.branch, files_committed: Object.keys(args.files) });
  } catch (err) {
    return formatBffError(err);
  }
}

// ── registration ─────────────────────────────────────────────────────────────

const PR_URL_DESCRIPTION = 'GitHub PR URL: https://github.com/{owner}/{repo}/pull/{number}.';

export function registerVcsTools(server: McpServer, bffClient: BffClient, getConfig: () => Config): void {
  server.registerTool(
    'vcs_pr_context',
    {
      description:
        "Read-only GitHub PR context — fetch diff, files, metadata, comments, reviews, CI " +
        "check-run results, commits, ref comparison, file content at a ref, or list open PRs. " +
        "PR-scoped actions (diff/files/metadata/comments/reviews/checks/commits) require pr_url. " +
        "compare requires owner, repo, base, and head. file_at_ref requires owner, repo, path, " +
        "and ref. list_prs requires owner and repo. Routes through vcs-service — no direct " +
        "GitHub API calls or GITHUB_TOKEN needed.",
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        action: z.enum(PR_CONTEXT_ACTIONS).describe('Operation to perform.'),
        pr_url: z.string().optional().describe(PR_URL_DESCRIPTION + ' Required for PR-scoped actions.'),
        owner: z.string().optional().describe('GitHub repo owner. Required for compare/file_at_ref/list_prs.'),
        repo: z.string().optional().describe('GitHub repo name. Required for compare/file_at_ref/list_prs.'),
        base: z.string().optional().describe("Base ref/branch/SHA for action='compare'."),
        head: z.string().optional().describe("Head ref/branch/SHA for action='compare'; branch filter for list_prs."),
        path: z.string().optional().describe("File path within the repo. Required for action='file_at_ref'."),
        ref: z.string().optional().describe("Git ref to read the file at. Required for action='file_at_ref'."),
        state: z.enum(['open', 'closed', 'all']).optional().describe("PR state filter for action='list_prs'. Default: open."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, getConfig().defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleVcsPrContext(args as VcsPrContextArgs, resolved.workspaceId, bffClient);
    },
  );

  server.registerTool(
    'vcs_pr_diff',
    {
      description: "Read a GitHub PR's unified diff. Use this before reviewing a PR or answering 'what changed'.",
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        pr_url: z.string().describe(PR_URL_DESCRIPTION),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, getConfig().defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleVcsPrDiff(args.pr_url, resolved.workspaceId, bffClient);
    },
  );

  server.registerTool(
    'vcs_pr_files',
    {
      description:
        "Read the list of files changed in a GitHub PR (paths, additions/deletions, status). " +
        "Use this before reviewing a PR or answering 'what files did this touch'.",
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        pr_url: z.string().describe(PR_URL_DESCRIPTION),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, getConfig().defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleVcsPrFiles(args.pr_url, resolved.workspaceId, bffClient);
    },
  );

  server.registerTool(
    'vcs_pr_review',
    {
      description:
        'Post a GitHub PR review using a two-call pattern: first posts the full narrative as an ' +
        'issue comment (always visible, not subject to self-review restriction), then posts a ' +
        'formal review event (APPROVE or REQUEST_CHANGES). If GitHub rejects the review event with ' +
        'HTTP 422 (self-review restriction), the tool still succeeds with self_review_skipped=true ' +
        '— the issue comment is the authoritative narrative. Use after vcs_pr_context to gather ' +
        'context.',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        pr_url: z.string().describe(PR_URL_DESCRIPTION),
        event: z.enum(['APPROVE', 'REQUEST_CHANGES']).describe('Review verdict.'),
        body: z.string().describe('Full review narrative, posted as the issue comment and the review event body.'),
        comments: z
          .array(
            z.object({
              path: z.string().describe('File path relative to the repo root.'),
              line: z.number().describe('Line number in the diff to attach the comment to.'),
              body: z.string().describe('Comment text.'),
            }),
          )
          .optional()
          .describe('Optional inline review comments attached to the formal review event.'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, getConfig().defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleVcsPrReview(args as VcsPrReviewArgs, resolved.workspaceId, bffClient);
    },
  );

  server.registerTool(
    'vcs_create_pr',
    {
      description:
        'Create a pull request via vcs-service. Opens a PR from `head` into `base` on the given ' +
        'GitHub repo. Returns the PR number and html_url on success.',
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        owner: z.string().describe('GitHub org or user that owns the repo.'),
        repo: z.string().describe('Repository name, without the owner prefix.'),
        title: z.string().describe('Pull request title.'),
        head: z.string().describe('Branch containing the changes (source branch).'),
        base: z.string().describe('Branch the PR merges into (target branch).'),
        body: z.string().optional().describe('Optional PR description.'),
        draft: z.boolean().optional().describe('Create as a draft PR. Defaults to false.'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, getConfig().defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleVcsCreatePr(args as VcsCreatePrArgs, resolved.workspaceId, bffClient);
    },
  );

  server.registerTool(
    'vcs_ensure_branch',
    {
      description:
        "Create a branch from a base branch via vcs-service, if it doesn't already exist on the " +
        "remote. Use this before vcs_create_pr when the PR's head branch hasn't been pushed yet — " +
        "GitHub's PR API rejects opening a PR whose head branch doesn't exist.",
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        owner: z.string().describe('GitHub org or user that owns the repo.'),
        repo: z.string().describe('Repository name, without the owner prefix.'),
        branch: z.string().describe('Name of the branch to create.'),
        base_branch: z.string().describe('Existing branch to branch from (e.g. main).'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, getConfig().defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleVcsEnsureBranch(args as VcsEnsureBranchArgs, resolved.workspaceId, bffClient);
    },
  );

  server.registerTool(
    'vcs_commit_files',
    {
      description:
        "Commit one or more files directly to a branch via vcs-service, using GitHub's Contents " +
        'API (no local git clone involved). Use after vcs_ensure_branch (if the branch is new) and ' +
        "before vcs_create_pr, to give the PR's head branch actual content.",
      inputSchema: {
        workspace_id: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        owner: z.string().describe('GitHub org or user that owns the repo.'),
        repo: z.string().describe('Repository name, without the owner prefix.'),
        branch: z.string().describe('Branch to commit to.'),
        message: z.string().describe('Commit message.'),
        files: z
          .record(z.string(), z.string())
          .describe('Map of file path (relative to repo root) to full file content — created or overwritten wholesale.'),
        base_branch: z
          .string()
          .optional()
          .describe("Optional. If `branch` doesn't exist yet, create it from this branch before committing."),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (args) => {
      const resolved = resolveWorkspaceId(args.workspace_id, getConfig().defaultWorkspaceId);
      if ('error' in resolved) return resolved.error;
      return handleVcsCommitFiles(args as VcsCommitFilesArgs, resolved.workspaceId, bffClient);
    },
  );
}
