import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Config } from './config.js';
import { resolveParticipant } from './channel.js';

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
  return errorResult(
    `Review request failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`,
  );
}

/**
 * Polls `GET /participants/{id}/pending-turn` for a review turn owed to this
 * paired agent — the server is the source of truth, not the local SSE buffer.
 */
export async function reviewGetTurn(config: Config, options: ReviewToolOptions = {}): Promise<ToolResult> {
  const participant = resolveParticipant(config, options.homeDir);
  if (!participant) return notPairedError();
  const id = encodeURIComponent(participant.participantId);
  return requestReview(
    config,
    `${HERMES_AGENT_PREFIX}/participants/${id}/pending-turn`,
    { method: 'GET' },
    participant.accessToken,
    options,
  );
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
  const participant = resolveParticipant(config, options.homeDir);
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
    'review_get_turn',
    {
      description:
        "Poll for a review turn owed to this paired agent. Run when the review view shows 'awaiting <handle>'.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => reviewGetTurn(config, options),
  );

  server.registerTool(
    'review_submit_reply',
    {
      description: "Post this agent's reply into the review conversation (author derived server-side).",
      inputSchema: {
        session_id: z.string().describe('Review session UUID owed a turn by this agent'),
        content: z.string().describe('Reply text to post into the review conversation'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => reviewSubmitReply(config, args, options),
  );
}
