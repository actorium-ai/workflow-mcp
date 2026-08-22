import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Config } from './config.js';
import { FreshParticipantOptions, resolveFreshParticipant } from './channel.js';

/**
 * Review tooling for the paired local agent (technical design §6). Two tools:
 * `review_get_turn` polls the SERVER's pending-turn endpoint — the source of
 * truth, never the local SSE buffer (the realtime bus drops on QueueFull with
 * no replay) — and `review_submit_reply` posts the agent's reply into the
 * review session. The author is derived server-side from the signed identity
 * header, so the client sends only `{ content }`. Both tools authenticate with
 * the pairing access token (`pairing.<hash>.json`), which carries the
 * `agent_participant_id` claim the BFF propagates into chat-agent's signed
 * `X-BFF-Identity` header.
 */
const HERMES_AGENT_PREFIX = '/bff/hermes-agent/api/v1';

type ToolResult = CallToolResult;

export interface ReviewToolOptions {
  /** Home-dir seam for locating the pairing file (default os.homedir()). */
  homeDir?: string;
  /** fetch seam for tests (default global fetch). */
  fetch?: typeof fetch;
  /** Device-flow refresh seam for tests (default deviceFlow.refresh). */
  refresh?: FreshParticipantOptions['refresh'];
}

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function notPairedError(): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          reason: 'not_paired',
          hint: 'Run `actorium-mcp pair` to pair this local agent first.',
        }),
      },
    ],
    isError: true,
  };
}

async function requestReview(
  config: Config,
  path: string,
  init: RequestInit,
  accessToken: string,
  options: ReviewToolOptions,
): Promise<ToolResult> {
  const fetchImpl = options.fetch ?? fetch;
  const url = `${config.bffUrl.replace(/\/$/, '')}${path}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (err) {
    return errorResult(`Review request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await response.text().catch(() => '');
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text || undefined;
  }

  if (response.ok) return jsonResult(body);
  // A 401 here means renewal could not save the pairing (revoked, or offline
  // past the refresh token's life). Say so explicitly — the agent otherwise
  // reports a bare 401 and the human has no idea the fix is to re-pair.
  if (response.status === 401) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            reason: 'pairing_expired',
            hint: 'This pairing is no longer valid. Run `actorium-mcp pair` to pair again.',
          }),
        },
      ],
      isError: true,
    };
  }
  return errorResult(
    `Review request failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`,
  );
}

/**
 * Polls `GET /participants/{id}/pending-turn` for a review turn owed to this
 * paired agent — the server is the source of truth, not the local SSE buffer.
 *
 * A `pending: false` response is enriched with an explicit wait instruction.
 * The bare payload reads as a terminal answer ("nothing owed"), and agents
 * treated it that way: they posted a review, polled once, saw false, and
 * stopped — abandoning the exchange while the counterpart was still composing
 * its turn. It means "not yet", and the response has to say so.
 */
export async function reviewGetTurn(config: Config, options: ReviewToolOptions = {}): Promise<ToolResult> {
  const participant = await resolveFreshParticipant(config, {
    homeDir: options.homeDir,
    refresh: options.refresh,
  });
  if (!participant) return notPairedError();
  const id = encodeURIComponent(participant.participantId);
  const result = await requestReview(
    config,
    `${HERMES_AGENT_PREFIX}/participants/${id}/pending-turn`,
    { method: 'GET' },
    participant.accessToken,
    options,
  );
  return withWaitHint(result);
}

/**
 * Adds a wait instruction to a "no turn owed" response. See reviewGetTurn.
 * Anything unparseable, errored, or already carrying a turn passes through.
 */
function withWaitHint(result: ToolResult): ToolResult {
  if (result.isError) return result;
  const first = result.content?.[0];
  if (!first || first.type !== 'text') return result;

  let body: unknown;
  try {
    body = JSON.parse(first.text);
  } catch {
    return result;
  }
  if (!body || typeof body !== 'object') return result;

  const payload = body as Record<string, unknown>;
  if (payload.pending !== false) return result;

  // review_active distinguishes the two meanings of "no turn owed". Without it
  // the agent either abandons a live exchange or polls a stopped one forever.
  // The counterpart is parked on a question for the human. No turn will ever
  // be owed until someone answers, so polling here just burns the idle bound
  // and the review dies as a timeout with the question still on screen.
  if (payload.awaiting_human === true) {
    return jsonResult({
      ...payload,
      hint:
        'The review is blocked: the other participant asked the HUMAN a question and is waiting ' +
        'for an answer. Stop polling and tell the human to answer the question shown in the ' +
        'review, then resume with review_get_turn once they have.',
    });
  }

  if (payload.review_active === false) {
    return jsonResult({
      ...payload,
      hint: 'The review has ended (finished, or stopped by the human). Stop polling and report what happened.',
    });
  }

  return jsonResult({
    ...payload,
    hint:
      'Not yet — the other participant is still working. This is not the end of the review. ' +
      'Wait ~10s and call review_get_turn again.',
  });
}

/**
 * Posts `{ content }` to `POST /threads/{session_id}/messages`; the author is
 * derived server-side from the signed identity header.
 */
export async function reviewSubmitReply(
  config: Config,
  args: { session_id: string; content: string },
  options: ReviewToolOptions = {},
): Promise<ToolResult> {
  const participant = await resolveFreshParticipant(config, {
    homeDir: options.homeDir,
    refresh: options.refresh,
  });
  if (!participant) return notPairedError();
  const sessionId = encodeURIComponent(args.session_id);
  return requestReview(
    config,
    `${HERMES_AGENT_PREFIX}/threads/${sessionId}/messages`,
    { method: 'POST', body: JSON.stringify({ content: args.content }) },
    participant.accessToken,
    options,
  );
}

/**
 * Starts a spec review from the agent side: `POST /reviews`.
 *
 * This is the entry point that replaces the web Start-review modal. Driving it
 * from a tool call removes the whole "paired but unreachable" failure class by
 * construction — if this handler is running, the MCP server is running, so the
 * presence lease the server checks is necessarily live. The modal could only
 * ever report that mismatch after the fact.
 *
 * `allow_broader_code_quoting` defaults to false and the tool description tells
 * the caller to confirm with the human before setting it. It governs whether
 * the agent may quote code from outside its working directory into a thread
 * other workspace members can read, so the human is the one who should decide.
 * Note this is an instruction, not an enforcement: nothing here can verify that
 * the confirmation actually happened, so it is weaker than the web checkbox it
 * replaces.
 */
export async function reviewStart(
  config: Config,
  args: {
    initial_prompt: string;
    feature_id: string;
    hermes_model_id: string;
    workspace_id?: string;
    first_responder?: string;
    allow_broader_code_quoting?: boolean;
  },
  options: ReviewToolOptions = {},
): Promise<ToolResult> {
  const participant = await resolveFreshParticipant(config, {
    homeDir: options.homeDir,
    refresh: options.refresh,
  });
  if (!participant) return notPairedError();

  const workspaceId = args.workspace_id ?? config.defaultWorkspaceId;
  if (!workspaceId) {
    return errorResult(
      'No workspace_id: pass one explicitly, or run actorium-mcp from a linked workspace folder.',
    );
  }

  return requestReview(
    config,
    `${HERMES_AGENT_PREFIX}/reviews`,
    {
      method: 'POST',
      body: JSON.stringify({
        feature_id: args.feature_id,
        workspace_id: workspaceId,
        initial_prompt: args.initial_prompt,
        // This agent goes first, by participant id. The loop is: reviewer
        // reports findings -> hermes updates the documents -> reviewer
        // re-checks -> ... Seeding hermes first inverts that, asking it to
        // change documents before anyone has said what is wrong with them.
        first_responder: args.first_responder ?? participant.participantId,
        hermes_model_id: args.hermes_model_id,
        allow_broader_code_quoting: args.allow_broader_code_quoting ?? false,
      }),
    },
    participant.accessToken,
    options,
  );
}

/**
 * Ends the review: `POST /reviews/{session_id}/end`.
 *
 * The reviewer is the one who knows when the exchange is done — it is the
 * participant checking the documents against real code, so it is the only one
 * that can say the findings are resolved. Without this the loop had no
 * satisfied exit: a review that had converged sat open until it hit a turn cap
 * or idled out, both of which read as failures rather than success.
 *
 * The transcript is preserved; this stops the exchange, it does not delete it.
 */
export async function reviewEnd(
  config: Config,
  args: { session_id: string; reason?: string },
  options: ReviewToolOptions = {},
): Promise<ToolResult> {
  const participant = await resolveFreshParticipant(config, {
    homeDir: options.homeDir,
    refresh: options.refresh,
  });
  if (!participant) return notPairedError();

  const sessionId = encodeURIComponent(args.session_id);
  return requestReview(
    config,
    `${HERMES_AGENT_PREFIX}/reviews/${sessionId}/end`,
    { method: 'POST', body: JSON.stringify({ reason: args.reason || 'reviewer_satisfied' }) },
    participant.accessToken,
    options,
  );
}

/**
 * Registers the paired-agent review tools on the MCP server. Handlers resolve
 * the pairing lazily at call time, so a pairing created after server start is
 * picked up without a restart.
 */
export function registerReviewTools(
  server: McpServer,
  config: Config,
  options: ReviewToolOptions = {},
): void {
  server.registerTool(
    'review_start',
    {
      description:
        'Start a spec review between hermes and this paired agent on a feature. ' +
        'Use when the human asks to start/run a spec review. The review then appears live in the web UI. ' +
        'Starting one commits you to running it: post your review, then poll review_get_turn and keep ' +
        'taking turns until you call review_end or the review ends on its own.',
      inputSchema: {
        initial_prompt: z.string().describe('What to review — seeds both participants (e.g. "review the product spec")'),
        feature_id: z.string().describe('Feature UUID to review'),
        hermes_model_id: z.string().describe('Model catalog id for hermes (e.g. "claude-sonnet-5")'),
        workspace_id: z
          .string()
          .optional()
          .describe('Workspace UUID; defaults to the linked workspace this server runs for'),
        first_responder: z
          .string()
          .optional()
          .describe(
            'Who takes the first turn: "hermes" or this agent\'s handle. ' +
              'Defaults to this agent, which reviews first.',
          ),
        allow_broader_code_quoting: z
          .boolean()
          .optional()
          .describe(
            'Let this agent quote code from outside its working directory. ' +
              'ASK THE HUMAN FIRST and only set true if they agree — the review transcript is ' +
              'readable by everyone in the workspace, so this can expose unrelated local code. ' +
              'Defaults to false.',
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => reviewStart(config, args, options),
  );

  server.registerTool(
    'review_end',
    {
      description:
        'End the review when your findings have been resolved. You are the reviewer, so you decide ' +
        'when the exchange is done — do this instead of leaving a converged review open to time out. ' +
        'The transcript is kept.',
      inputSchema: {
        session_id: z.string().describe('Review session UUID to end'),
        reason: z
          .string()
          .optional()
          .describe('Why it ended; defaults to "reviewer_satisfied"'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => reviewEnd(config, args, options),
  );

  server.registerTool(
    'review_get_turn',
    {
      description:
        'Check whether a review turn is owed to this paired agent. ' +
        'Returns {"pending": false} while the other participant is still working — that means ' +
        'NOT YET, not finished. A counterpart turn involves a model thinking and writing, so it ' +
        'commonly takes 30-120s to appear. After posting a reply, keep calling this every ~10s ' +
        'until it returns a turn, rather than reporting back that nothing is pending. ' +
        'Each turn you get is the other participant\'s updated documents — re-check them against the code and either raise what is still wrong or, if your findings are resolved, call review_end. Stop when the response says the review has ended — that includes the human stopping it.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => reviewGetTurn(config, options),
  );

  server.registerTool(
    'review_submit_reply',
    {
      description:
        "Post this agent's reply into the review conversation (author derived server-side). " +
        'AFTER POSTING, IMMEDIATELY call review_get_turn and keep polling until a turn comes back. ' +
        'Do not stop here and do not ask the human whether to continue — you own this loop until ' +
        'the review ends, and pausing to ask strands the exchange with the other participant ' +
        'waiting on a turn that never comes.',
      inputSchema: {
        session_id: z.string().describe('Review session UUID owed a turn by this agent'),
        content: z.string().describe('Reply text to post into the review conversation'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => reviewSubmitReply(config, args, options),
  );
}
