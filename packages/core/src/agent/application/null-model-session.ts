// The model session of a code-backed agent, which opens no provider.

import type { ModelSession, ModelSessionEvent, ModelSessionParams } from "../domain/model-port.js";

/**
 * A `ModelSession` for a **code-backed agent**: one whose turns
 * are always produced by a turn-middleware rather than a model. It opens no
 * provider query — nothing to resume, nothing to bill, no background SDK stream
 * that could error — so the events iterable simply parks until `close()`.
 *
 * For a correctly-configured code-backed agent a turn middleware short-circuits
 * every turn, so `sendUserInput` is never reached. If it is (no middleware
 * matched — a misconfiguration), the turn is terminated gracefully with a
 * fallback error rather than hanging, so the session never wedges.
 */
export function createNullModelSession(params: ModelSessionParams): ModelSession {
  const buffer: ModelSessionEvent[] = [];
  const resolvers: Array<(item: IteratorResult<ModelSessionEvent>) => void> = [];
  let closed = false;

  const emit = (msg: ModelSessionEvent) => {
    if (closed) return;
    if (resolvers.length > 0) {
      resolvers.shift()!({ value: msg, done: false });
    } else {
      buffer.push(msg);
    }
  };

  const events: AsyncIterable<ModelSessionEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<ModelSessionEvent>> {
          if (buffer.length > 0) return { value: buffer.shift()!, done: false };
          if (closed) return { value: undefined as never, done: true };
          return await new Promise<IteratorResult<ModelSessionEvent>>((resolve) => {
            resolvers.push(resolve);
          });
        },
      };
    },
  };

  const FALLBACK =
    "This conversation is handled by code, not a model, and no handler took this turn. You can start chatting with Rome normally.";

  return {
    providerId: "mock",
    model: params.config.model,
    events,
    async sendUserInput(): Promise<void> {
      emit({ type: "text", content: FALLBACK });
      emit({ type: "error", error: "No handler took this turn" });
    },
    async interrupt(): Promise<void> {},
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      while (resolvers.length > 0) {
        resolvers.shift()!({ value: undefined as never, done: true });
      }
    },
  };
}
