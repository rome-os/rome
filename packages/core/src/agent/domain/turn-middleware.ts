// The middleware installed apps put around producing a turn's reply
// (docs/concepts/apps.md). A middleware may rewrite the turn's prompt, answer
// the turn itself, or let the model answer.

import type { AgentEvent } from "@rome-os/app-runtime";
import type { ModelReasoningEffort } from "./model-port.js";
import type { AgentName, ContinuityKey, SessionId } from "./session.js";

/**
 * Port. The middleware installed apps put around producing a turn's reply.
 * The model's reply is innermost and runs only when every middleware
 * continues. A middleware that fails open is skipped; one that fails closed
 * rejects the call.
 */
export interface TurnMiddleware {
  run(
    turn: {
      sessionId: SessionId;
      agentName: AgentName;
      continuityKey: ContinuityKey;
      /** A middleware may rewrite these before the model reads them. */
      input: { prompt: string; reasoningEffort?: ModelReasoningEffort };
      /** Publishes the turn's content when a middleware answers it. */
      emit(event: AgentEvent): void;
    },
    modelReply: () => Promise<void>,
  ): Promise<void>;
}
