import { context, type Context } from "@opentelemetry/api";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { AgentTurnHandle } from "../agent/index.js";

/** What a test fake of a turn says: its id, its events, and optionally how it stops. */
export interface FakeTurn {
  turnId: string;
  events: AsyncIterable<StreamAgentEvent>;
  interrupt?: (reason?: string) => Promise<unknown>;
  turnContext?: Context;
}

/**
 * A turn handle over a fake. Its events are the fake's own iterable, so they
 * are read once and lazily, as the fake wrote them. It ends when its events
 * have been read to the end.
 */
export function testTurnHandle(fake: FakeTurn): AgentTurnHandle {
  let ended = false;
  let resolveEnded!: () => void;
  const endedPromise = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  return {
    id: fake.turnId,
    get hasEnded() {
      return ended;
    },
    events: () => ({
      async *[Symbol.asyncIterator]() {
        try {
          yield* fake.events;
        } finally {
          ended = true;
          resolveEnded();
        }
      },
    }),
    ended: () => endedPromise.then(() => ({ stoppedByRome: false })),
    async stop(reason) {
      if (ended) return "ended";
      await fake.interrupt?.(reason);
      return "requested";
    },
    turnContext: fake.turnContext ?? context.active(),
  };
}
