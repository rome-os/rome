// How a Codex app-server turn ended, as Rome's stop reason. How a whole turn
// ended is the agent's rule, in agent/domain/turn-end.ts.

import type { AgentStop } from "@rome-os/app-runtime";

/**
 * Stop for a Codex app-server turn from its `turn/completed` status
 * (`completed`, `interrupted`, `failed`, or `inProgress`). Codex reports no
 * output-limit status at turn level, so it never yields `max_tokens`.
 *
 * `failed` is true when the turn itself fails, rather than completing with
 * output that Rome then rejects. The stop is then `error` whatever the status,
 * and the status stays as `raw`, the way `anthropicStop` reports a failed
 * Claude result. `turnStop` reads an `interrupted` stop as a stopped turn, so a
 * failed turn's accounting never carries one.
 */
export function codexStop(status: string | undefined, failed = false): AgentStop {
  if (failed) return status ? { reason: "error", raw: status } : { reason: "error" };
  switch (status) {
    case "completed":
      return { reason: "completed", raw: status };
    case "interrupted":
      return { reason: "interrupted", raw: status };
    case "failed":
      return { reason: "error", raw: status };
    default:
      return status ? { reason: "other", raw: status } : { reason: "other" };
  }
}
