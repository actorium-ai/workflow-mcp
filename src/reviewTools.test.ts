import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { registerReviewTools, reviewGetTurn, reviewStart, reviewSubmitReply } from './reviewTools';
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

    // The description carries the polling contract, since that is what the
    // calling model reads to decide whether to wait or give up.
    const getTurnDescription = tools['review_get_turn']?.description ?? '';
    expect(getTurnDescription).toContain('review turn is owed');
    expect(getTurnDescription).toMatch(/keep calling|call.*again/i);
    expect(getTurnDescription).toMatch(/stop when/i);
    expect(tools['review_get_turn']?.annotations?.readOnlyHint).toBe(true);

    // The description carries the loop obligation: agents were posting a reply
    // and then asking the human whether to continue, stranding the exchange.
    const submitDescription = tools['review_submit_reply']?.description ?? '';
    expect(submitDescription).toContain('author derived server-side');
    expect(submitDescription).toMatch(/review_get_turn/);
    expect(submitDescription).toMatch(/do not ask the human/i);
    expect(tools['review_submit_reply']?.annotations?.readOnlyHint).toBe(false);
  });
});

describe('reviewStart turn order', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'actorium-start-test-'));
    writePairing(tempHome);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function okFetch() {
    return jest.fn().mockResolvedValue(makeResponse(200, { session_id: 's-1' }));
  }

  async function startWith(overrides: Record<string, unknown> = {}) {
    const fetchImpl = okFetch();
    await reviewStart(
      CONFIG,
      { initial_prompt: 'review it', feature_id: 'f-1', hermes_model_id: 'm-1', workspace_id: 'ws-1', ...overrides },
      { homeDir: tempHome, fetch: fetchImpl as unknown as typeof fetch },
    );
    return JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
  }

  // The loop is reviewer-first: findings, then hermes updates the documents,
  // then the reviewer re-checks. Seeding hermes first asks it to change
  // documents before anyone has said what is wrong with them.
  it('defaults the first turn to this agent, not hermes', async () => {
    const body = await startWith();
    expect(body.first_responder).toBe('participant-123');
    expect(body.first_responder).not.toBe('hermes');
  });

  it('honours an explicit first_responder', async () => {
    const body = await startWith({ first_responder: 'hermes' });
    expect(body.first_responder).toBe('hermes');
  });

  // Broader quoting is the human's consent decision; the default must be off.
  it('defaults allow_broader_code_quoting to false', async () => {
    const body = await startWith();
    expect(body.allow_broader_code_quoting).toBe(false);
  });
});

describe('reviewGetTurn wait hints', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'actorium-hint-test-'));
    writePairing(tempHome);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  async function hintFor(body: unknown): Promise<string> {
    const fetchImpl = jest.fn().mockResolvedValue(makeResponse(200, body));
    const result = await reviewGetTurn(CONFIG, {
      homeDir: tempHome,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const text = (result.content?.[0] as { text: string }).text;
    return (JSON.parse(text) as { hint?: string }).hint ?? '';
  }

  it('tells the agent to keep waiting while the review is live', async () => {
    expect(await hintFor({ pending: false, review_active: true, awaiting_human: false })).toMatch(/wait/i);
  });

  it('tells the agent to stop once the review has ended', async () => {
    expect(await hintFor({ pending: false, review_active: false, awaiting_human: false })).toMatch(/ended/i);
  });

  // Polling through this just burns the idle bound and kills the review while
  // the question sits unanswered on screen.
  it('tells the agent to surface a question waiting on the human', async () => {
    const hint = await hintFor({ pending: false, review_active: true, awaiting_human: true });
    expect(hint).toMatch(/blocked/i);
    expect(hint).toMatch(/human/i);
    expect(hint).toMatch(/stop polling/i);
  });

  it('leaves an actual turn untouched', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(makeResponse(200, { turn: { session_id: 's-1' } }));
    const result = await reviewGetTurn(CONFIG, {
      homeDir: tempHome,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const body = JSON.parse((result.content?.[0] as { text: string }).text);
    expect(body.turn).toEqual({ session_id: 's-1' });
    expect(body.hint).toBeUndefined();
  });
});
