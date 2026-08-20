import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { registerReviewTools, reviewGetTurn, reviewSubmitReply } from './reviewTools';
import { savePairing } from './pairingStore';

const BFF = 'http://bff.example.com';
const CONFIG = { bffUrl: BFF };

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const ACCESS_TOKEN = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
  agent_participant_id: 'participant-123',
})}.signature`;

function writePairing(homeDir: string): void {
  savePairing(
    BFF,
    {
      accessToken: ACCESS_TOKEN,
      refreshToken: 'refresh-1',
      expiresIn: 3600,
      handle: 'dev-agent',
      clientId: 'actorium-local-agent',
      bffUrl: BFF,
      updatedAt: Date.now(),
    },
    homeDir,
  );
}

function makeResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  if (!item || item.type !== 'text' || item.text === undefined) throw new Error('Expected text content');
  return item.text;
}

describe('reviewGetTurn', () => {
  let tempHome: string;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'actorium-reviewtools-test-'));
    mockFetch = jest.fn();
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const options = () => ({ homeDir: tempHome, fetch: mockFetch as unknown as typeof fetch });

  it('returns a not_paired error when there is no pairing, without calling the server', async () => {
    const result = await reviewGetTurn(CONFIG, options());

    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result))).toMatchObject({ ok: false, reason: 'not_paired' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('polls pending-turn authenticated as the participant and returns the body', async () => {
    writePairing(tempHome);
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, { turn: { session_id: 's1', prompt: 'hi', seed: 'spec excerpt' } }),
    );

    const result = await reviewGetTurn(CONFIG, options());

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual({
      turn: { session_id: 's1', prompt: 'hi', seed: 'spec excerpt' },
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BFF}/bff/hermes-agent/api/v1/participants/participant-123/pending-turn`);
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${ACCESS_TOKEN}` });
  });

  it('returns an error result carrying the status and server code when rejected', async () => {
    writePairing(tempHome);
    mockFetch.mockResolvedValueOnce(makeResponse(403, { detail: { code: 'not_your_participant' } }));

    const result = await reviewGetTurn(CONFIG, options());

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('403');
    expect(firstText(result)).toContain('not_your_participant');
  });
});

describe('reviewSubmitReply', () => {
  let tempHome: string;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'actorium-reviewtools-test-'));
    mockFetch = jest.fn();
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const options = () => ({ homeDir: tempHome, fetch: mockFetch as unknown as typeof fetch });

  it('returns a not_paired error when there is no pairing', async () => {
    const result = await reviewSubmitReply(CONFIG, { session_id: 's1', content: 'hi' }, options());

    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result))).toMatchObject({ ok: false, reason: 'not_paired' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs {content} to the messages route and returns the body', async () => {
    writePairing(tempHome);
    mockFetch.mockResolvedValueOnce(makeResponse(200, { id: 'msg-1' }));

    const result = await reviewSubmitReply(
      CONFIG,
      { session_id: 's1', content: 'review reply' },
      options(),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual({ id: 'msg-1' });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BFF}/bff/hermes-agent/api/v1/threads/s1/messages`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    expect(JSON.parse(init.body as string)).toEqual({ content: 'review reply' });
  });

  it('surfaces an out_of_turn (409) rejection as an error result', async () => {
    writePairing(tempHome);
    mockFetch.mockResolvedValueOnce(makeResponse(409, { detail: { code: 'out_of_turn' } }));

    const result = await reviewSubmitReply(
      CONFIG,
      { session_id: 's1', content: 'x' },
      options(),
    );

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('409');
    expect(firstText(result)).toContain('out_of_turn');
  });
});

describe('registerReviewTools', () => {
  it('registers both tools with the specified names, copy, and annotations', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerReviewTools(server, CONFIG);

    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { description?: string; annotations?: { readOnlyHint?: boolean } }
        >;
      }
    )._registeredTools;

    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['review_get_turn', 'review_submit_reply']));

    expect(tools['review_get_turn']?.description).toBe(
      "Poll for a review turn owed to this paired agent. Run when the review view shows 'awaiting <handle>'.",
    );
    expect(tools['review_get_turn']?.annotations?.readOnlyHint).toBe(true);

    expect(tools['review_submit_reply']?.description).toBe(
      "Post this agent's reply into the review conversation (author derived server-side).",
    );
    expect(tools['review_submit_reply']?.annotations?.readOnlyHint).toBe(false);
  });
});
