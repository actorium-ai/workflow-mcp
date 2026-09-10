import { BffClient, BffAuthError, BffRequestError } from './bffClient';
import {
  parsePrUrl,
  resolveConnectionId,
  handleVcsPrContext,
  handleVcsPrDiff,
  handleVcsPrFiles,
  handleVcsPrReview,
  handleVcsCreatePr,
  handleVcsEnsureBranch,
  handleVcsCommitFiles,
} from './vcsTools';
import { ToolResult } from './tools';

jest.mock('./bffClient', () => {
  const actual = jest.requireActual('./bffClient') as typeof import('./bffClient');
  return {
    BffAuthError: actual.BffAuthError,
    BffRequestError: actual.BffRequestError,
    BffClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      patch: jest.fn(),
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

const WS = 'ws-uuid-1';
const PR_URL = 'https://github.com/acme/widgets/pull/42';

describe('parsePrUrl', () => {
  it('extracts owner/repo/pullNumber from a valid PR URL', () => {
    expect(parsePrUrl(PR_URL)).toEqual({ owner: 'acme', repo: 'widgets', pullNumber: 42 });
  });

  it('returns an error for a malformed URL', () => {
    const result = parsePrUrl('https://github.com/acme/widgets');
    expect('error' in result).toBe(true);
  });
});

describe('resolveConnectionId', () => {
  it('matches a workspace repo row by owner/repo parsed from repo_url', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({
      success: true,
      data: [
        { repo_url: 'https://github.com/acme/other.git', vcs_connection_id: 'conn-other' },
        { repo_url: 'https://github.com/acme/widgets', vcs_connection_id: 'conn-widgets' },
      ],
    });

    const id = await resolveConnectionId(WS, 'acme', 'widgets', client);

    expect(id).toBe('conn-widgets');
    expect(client.get).toHaveBeenCalledWith(`/bff/workflow-backend/api/workspaces/${WS}/repos`);
  });

  it('returns undefined (never throws) when no row matches or the lookup fails', async () => {
    const client = makeClient();
    client.get = jest.fn().mockRejectedValueOnce(new Error('boom'));

    await expect(resolveConnectionId(WS, 'acme', 'widgets', client)).resolves.toBeUndefined();
  });
});

describe('handleVcsPrDiff / handleVcsPrFiles', () => {
  it('resolves connection_id and posts to /pr/diff', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: [] });
    client.post = jest.fn().mockResolvedValueOnce({ diff: '--- a\n+++ b\n' });

    const result = await handleVcsPrDiff(PR_URL, WS, client);

    expect(client.post).toHaveBeenCalledWith('/bff/vcs-service/api/vcs/pr/diff', {
      owner: 'acme',
      repo: 'widgets',
      number: 42,
    });
    expect(JSON.parse(firstText(result))).toEqual({ ok: true, diff: '--- a\n+++ b\n' });
  });

  it('includes connection_id in the payload when resolved', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({
      success: true,
      data: [{ repo_url: 'https://github.com/acme/widgets', vcs_connection_id: 'conn-1' }],
    });
    client.post = jest.fn().mockResolvedValueOnce({ files: [] });

    await handleVcsPrFiles(PR_URL, WS, client);

    expect(client.post).toHaveBeenCalledWith('/bff/vcs-service/api/vcs/pr/files', {
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      connection_id: 'conn-1',
    });
  });

  it('returns an error result for an invalid PR URL without calling the client', async () => {
    const client = makeClient();
    client.post = jest.fn();

    const result = await handleVcsPrDiff('not-a-pr-url', WS, client);

    expect(result.isError).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe('handleVcsPrContext', () => {
  beforeEach(() => {
    // Every action call resolves connection_id via GET .../repos first.
  });

  it('action=metadata requires no extra fields and returns metadata', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: [] });
    client.post = jest.fn().mockResolvedValueOnce({ title: 'Add widgets', head_sha: 'abc' });

    const result = await handleVcsPrContext({ action: 'metadata', pr_url: PR_URL }, WS, client);

    expect(client.post).toHaveBeenCalledWith('/bff/vcs-service/api/vcs/pr/metadata', {
      owner: 'acme',
      repo: 'widgets',
      number: 42,
    });
    expect(JSON.parse(firstText(result))).toMatchObject({ ok: true, metadata: { title: 'Add widgets' } });
  });

  it('action=checks first resolves head_sha from metadata, then fetches checks', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: [] });
    client.post = jest
      .fn()
      .mockResolvedValueOnce({ head_sha: 'sha-1' }) // metadata
      .mockResolvedValueOnce({ status: 'passed', check_runs: [] }); // checks

    const result = await handleVcsPrContext({ action: 'checks', pr_url: PR_URL }, WS, client);

    expect(client.post).toHaveBeenNthCalledWith(1, '/bff/vcs-service/api/vcs/pr/metadata', {
      owner: 'acme',
      repo: 'widgets',
      number: 42,
    });
    expect(client.post).toHaveBeenNthCalledWith(2, '/bff/vcs-service/api/vcs/pr/checks', {
      owner: 'acme',
      repo: 'widgets',
      head_sha: 'sha-1',
    });
    expect(JSON.parse(firstText(result))).toMatchObject({ ok: true, status: 'passed' });
  });

  it('action=compare requires owner/repo/base/head', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValue({ success: true, data: [] });

    const result = await handleVcsPrContext({ action: 'compare', owner: 'acme', repo: 'widgets' }, WS, client);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/base and head are required/);
  });

  it('action=file_at_ref decodes base64 content', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: [] });
    client.post = jest.fn().mockResolvedValueOnce({
      path: 'a.txt',
      encoding: 'base64',
      content: Buffer.from('hello').toString('base64'),
    });

    const result = await handleVcsPrContext(
      { action: 'file_at_ref', owner: 'acme', repo: 'widgets', path: 'a.txt', ref: 'main' },
      WS,
      client,
    );

    expect(JSON.parse(firstText(result))).toMatchObject({ ok: true, content: 'hello' });
  });

  it('a PR-scoped action without pr_url is an error', async () => {
    const client = makeClient();
    const result = await handleVcsPrContext({ action: 'diff' }, WS, client);
    expect(result.isError).toBe(true);
  });
});

describe('handleVcsPrReview', () => {
  it('posts the issue comment then the review event on success', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: [] });
    client.post = jest
      .fn()
      .mockResolvedValueOnce({ html_url: 'https://github.com/acme/widgets/pull/42#comment-1' })
      .mockResolvedValueOnce({ html_url: 'https://github.com/acme/widgets/pull/42#review-1' });

    const result = await handleVcsPrReview({ pr_url: PR_URL, event: 'APPROVE', body: 'lgtm' }, WS, client);

    expect(client.post).toHaveBeenNthCalledWith(1, '/bff/vcs-service/api/vcs/pr/issue_comment', {
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      body: 'lgtm',
    });
    expect(client.post).toHaveBeenNthCalledWith(2, '/bff/vcs-service/api/vcs/pr/reviews', {
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      event: 'APPROVE',
      body: 'lgtm',
    });
    expect(JSON.parse(firstText(result))).toEqual({
      ok: true,
      review_url: 'https://github.com/acme/widgets/pull/42#review-1',
      self_review_skipped: false,
    });
  });

  it('treats HTTP 422 on the review event as self_review_skipped, not a failure', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: [] });
    client.post = jest
      .fn()
      .mockResolvedValueOnce({ html_url: 'https://github.com/acme/widgets/pull/42#comment-1' })
      .mockRejectedValueOnce(new BffRequestError('unprocessable', 422, {}));

    const result = await handleVcsPrReview({ pr_url: PR_URL, event: 'APPROVE', body: 'lgtm' }, WS, client);

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual({
      ok: true,
      review_url: 'https://github.com/acme/widgets/pull/42#comment-1',
      self_review_skipped: true,
    });
  });

  it('fails fatally if the issue comment step itself fails', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: [] });
    client.post = jest.fn().mockRejectedValueOnce(new BffRequestError('server error', 500, {}));

    const result = await handleVcsPrReview({ pr_url: PR_URL, event: 'APPROVE', body: 'lgtm' }, WS, client);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/step 1/);
  });

  it('surfaces session_expired on auth failure during the review step', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: [] });
    client.post = jest
      .fn()
      .mockResolvedValueOnce({ html_url: 'c' })
      .mockRejectedValueOnce(new BffAuthError('expired'));

    const result = await handleVcsPrReview({ pr_url: PR_URL, event: 'APPROVE', body: 'lgtm' }, WS, client);

    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result))).toMatchObject({ reason: 'session_expired' });
  });
});

describe('handleVcsCreatePr / handleVcsEnsureBranch / handleVcsCommitFiles', () => {
  it('vcs_create_pr posts to /pr/create and returns number/html_url', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: [] });
    client.post = jest.fn().mockResolvedValueOnce({ number: 7, html_url: 'https://github.com/acme/widgets/pull/7' });

    const result = await handleVcsCreatePr(
      { owner: 'acme', repo: 'widgets', title: 'Add thing', head: 'feat', base: 'main' },
      WS,
      client,
    );

    expect(client.post).toHaveBeenCalledWith('/bff/vcs-service/api/vcs/pr/create', {
      owner: 'acme',
      repo: 'widgets',
      title: 'Add thing',
      head: 'feat',
      base: 'main',
      body: '',
      draft: false,
    });
    expect(JSON.parse(firstText(result))).toMatchObject({ ok: true, number: 7 });
  });

  it('vcs_ensure_branch posts to /repo/ensure_branch', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: [] });
    client.post = jest.fn().mockResolvedValueOnce({});

    const result = await handleVcsEnsureBranch(
      { owner: 'acme', repo: 'widgets', branch: 'feat', base_branch: 'main' },
      WS,
      client,
    );

    expect(client.post).toHaveBeenCalledWith('/bff/vcs-service/api/vcs/repo/ensure_branch', {
      owner: 'acme',
      repo: 'widgets',
      branch: 'feat',
      base_branch: 'main',
    });
    expect(JSON.parse(firstText(result))).toEqual({ ok: true, branch: 'feat' });
  });

  it('vcs_commit_files rejects an empty files map without calling the client', async () => {
    const client = makeClient();
    client.post = jest.fn();

    const result = await handleVcsCommitFiles(
      { owner: 'acme', repo: 'widgets', branch: 'feat', message: 'msg', files: {} },
      WS,
      client,
    );

    expect(result.isError).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('vcs_commit_files posts to /repo/commit_files', async () => {
    const client = makeClient();
    client.get = jest.fn().mockResolvedValueOnce({ success: true, data: [] });
    client.post = jest.fn().mockResolvedValueOnce({});

    const result = await handleVcsCommitFiles(
      { owner: 'acme', repo: 'widgets', branch: 'feat', message: 'msg', files: { 'a.txt': 'hi' } },
      WS,
      client,
    );

    expect(client.post).toHaveBeenCalledWith('/bff/vcs-service/api/vcs/repo/commit_files', {
      owner: 'acme',
      repo: 'widgets',
      branch: 'feat',
      message: 'msg',
      files: { 'a.txt': 'hi' },
    });
    expect(JSON.parse(firstText(result))).toEqual({ ok: true, branch: 'feat', files_committed: ['a.txt'] });
  });
});
