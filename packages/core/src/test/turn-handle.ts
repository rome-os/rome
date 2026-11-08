import { context, type Context } from "@opentelemetry/api";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type {
  AgentInputReceipt,
  AgentSession,
  AgentTurnHandle,
  AgentTurnInput,
  SendTurnOptions,
  SubmitOptions,
} from "../agent/index.js";

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

/** The receipt of an input that started its own turn: `handle`. */
export function testReceipt(handle: AgentTurnHandle, inputId?: string): AgentInputReceipt {
  return {
    ...(inputId ? { inputId } : {}),
    turnId: handle.id,
    landed: "started",
    turn: Promise.resolve(handle),
  };
}

type StartTurn = (input: AgentTurnInput, options?: SendTurnOptions) => AgentTurnHandle;

/**
 * A fake session's `submit`, over the `startTurn` the fake scripts: each input
 * starts a turn of its own at once. It reads `startTurn` off the session it is
 * called on.
 */
export function submitStartingTurn(
  this: { startTurn: StartTurn },
  input: AgentTurnInput,
  options?: SubmitOptions,
): AgentInputReceipt {
  const { priority: _priority, onInputStatus: _onInputStatus, ...turnOptions } = options ?? {};
  return testReceipt(this.startTurn(input, turnOptions), input.inputId);
}

/** Starts a turn on a real session the way an app, action or subagent does: `after` the running one. */
export function startAfter(
  session: Pick<AgentSession, "submit">,
  input: AgentTurnInput,
  options?: SendTurnOptions,
): Promise<AgentTurnHandle> {
  return session.submit(input, { ...options, priority: "after" }).turn;
}
