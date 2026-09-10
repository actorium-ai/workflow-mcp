import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Shared "your login session is no longer valid" result — used by every tool
 * (the plain-bearer tools in tools.ts, via BffClient's BffAuthError, and the
 * review tools in reviewTools.ts) so a calling agent sees one consistent,
 * actionable signal on genuine auth failure, not two differently-worded
 * conventions depending on which tool it happened to call.
 */
export const SESSION_EXPIRED_HINT =
  'Your login session is no longer valid. Log in again via the Actorium VS Code extension.';

/**
 * Builds the structured `{ok:false, reason:'session_expired', hint}` tool
 * result. `detail` carries extra context worth keeping (e.g. BffAuthError's
 * account/backend-scoped message) without changing the reason/hint wording a
 * calling agent keys off of.
 */
export function sessionExpiredResult(detail?: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          reason: 'session_expired',
          hint: SESSION_EXPIRED_HINT,
          ...(detail ? { detail } : {}),
        }),
      },
    ],
    isError: true,
  };
}
