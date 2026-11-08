// A turn of a session, from its start to its ending. The words are in
// docs/concepts/sessions.md (Turn, Stop) and docs/domains/agents.md.

import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { TurnEnding } from "./turn-end.js";

/** What a stop came to: asked of the running turn, too late because it had ended, or refused because a forked turn cannot be stopped. */
export type TurnStopAnswer = "requested" | "ended" | "cannot_stop";

/**
 * One turn of a session. Its events are kept from the start, so every reader
 * sees all of them in order. A turn ends once, and a stop reaches this turn and
 * no other.
 */
export interface Turn {
  readonly id: string;
  readonly hasEnded: boolean;
  /** Every event from the turn's start, then each new one, until the turn ends. Each call is a new reader. */
  events(): AsyncIterable<StreamAgentEvent>;
  /** Resolves once, with how the turn ended. */
  ended(): Promise<TurnEnding>;
  /**
   * Asks this turn to stop, and resolves once the request has reached the
   * model session. Whether the turn has ended by then is `hasEnded`.
   */
  stop(reason?: string): Promise<TurnStopAnswer>;
}

/** The side of a turn its session holds: what it says, and how it ended. */
export interface TurnWriter {
  /** Adds an event. Ignored once the turn has ended. */
  record(event: StreamAgentEvent): void;
  /** Ends the turn. Only the first call counts. */
  end(ending: TurnEnding): void;
}

/**
 * A new turn. `stop` carries a stop to the model session, and is null for a
 * turn that cannot be stopped.
 */
export function createTurn(
  id: string,
  stop: ((reason?: string) => Promise<void>) | null,
): { turn: Turn; writer: TurnWriter } {
  const events: StreamAgentEvent[] = [];
  const waiting = new Set<() => void>();
  let ending: TurnEnding | undefined;
  let resolveEnded!: (ending: TurnEnding) => void;
  const endedPromise = new Promise<TurnEnding>((resolve) => {
    resolveEnded = resolve;
  });
  const wake = () => {
    for (const resume of [...waiting]) resume();
    waiting.clear();
  };

  const turn: Turn = {
    id,
    get hasEnded() {
      return ending !== undefined;
    },
    events() {
      return {
        async *[Symbol.asyncIterator]() {
          let next = 0;
          while (true) {
            while (next < events.length) yield events[next++];
            if (ending !== undefined) return;
            await new Promise<void>((resume) => waiting.add(resume));
          }
        },
      };
    },
    ended: () => endedPromise,
    async stop(reason) {
      if (ending !== undefined) return "ended";
      if (stop === null) return "cannot_stop";
      await stop(reason);
      return "requested";
    },
  };

  const writer: TurnWriter = {
    record(event) {
      if (ending !== undefined) return;
      events.push(event);
      wake();
    },
    end(how) {
      if (ending !== undefined) return;
      ending = how;
      resolveEnded(how);
      wake();
    },
  };

  return { turn, writer };
}
