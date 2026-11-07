// A Claude query does not outlive an interrupt: stopping a turn aborts the CLI
// process behind it. The model session does, so the next input opens a new
// query on the same thread and the events stream carries on across both.

import type {
  ModelSession,
  ModelSessionEvent,
  ModelSessionParams,
  ModelUserInput,
} from "../../../domain/model-port.js";
import { createLogger } from "../../../../logger.js";
import { AsyncMessageQueue } from "./async-message-queue.js";

const log = createLogger("anthropic-reopening-session");

/** One Claude CLI process. `ended` once an interrupt or its stream has taken it down. */
export interface ClaudeQuerySession extends ModelSession {
  readonly ended: boolean;
}

export function createReopeningSession(args: {
  params: ModelSessionParams;
  first: ClaudeQuerySession;
  open(params: ModelSessionParams): Promise<ClaudeQuerySession>;
  reasoningEffort: string;
}): ModelSession {
  const { params, open } = args;
  let query = args.first;
  let turnOpen = false;
  let interrupted = false;
  let closed = false;
  let abandoned = false;
  let reopening: Promise<void> | undefined;
  const outbox = new AsyncMessageQueue<ModelSessionEvent>();

  /** The terminal of a turn whose query ended without giving one. */
  const lostTurnTerminal = (failure: unknown): ModelSessionEvent => {
    if (interrupted && failure === undefined) {
      return params.config.outputSchema
        ? { type: "error", error: "Claude structured-output turn was interrupted" }
        : { type: "result", content: "", reasoningEffort: args.reasoningEffort };
    }
    return {
      type: "error",
      error: failure instanceof Error ? failure.message : "session closed mid-turn",
    };
  };

  /** Read a query to its end, whether or not anyone is reading the session. */
  const pump = async (current: ClaudeQuerySession): Promise<void> => {
    let failure: unknown;
    try {
      for await (const event of current.events) {
        if (event.type === "result" || event.type === "error") turnOpen = false;
        outbox.push(event);
      }
    } catch (err) {
      failure = err;
      log.warn("claude query stream failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (turnOpen) {
      turnOpen = false;
      outbox.push(lostTurnTerminal(failure));
    }
  };
  let pumped = pump(query);

  const events: AsyncIterable<ModelSessionEvent> = (async function* () {
    try {
      yield* outbox.iter();
    } finally {
      abandoned = true;
    }
  })();

  const reopen = (): Promise<void> => {
    reopening ??= (async () => {
      const ended = query;
      await ended.close();
      await pumped;
      query = await open({
        ...params,
        thread: ended.modelThreadId
          ? { kind: "resume", modelThreadId: ended.modelThreadId }
          : params.thread,
      });
      pumped = pump(query);
    })().finally(() => {
      reopening = undefined;
    });
    return reopening;
  };

  const settled = async (): Promise<void> => {
    await reopening?.catch(() => undefined);
  };

  const assertOpen = (): void => {
    if (closed || abandoned) throw new Error("ModelSession is closed");
  };

  return {
    providerId: args.first.providerId,
    get model(): string {
      return query.model;
    },
    get loginKind() {
      return query.loginKind;
    },
    get modelThreadId() {
      return query.modelThreadId;
    },
    events,
    async sendUserInput(input: ModelUserInput): Promise<void> {
      assertOpen();
      if (query.ended) await reopen();
      turnOpen = true;
      interrupted = false;
      try {
        await query.sendUserInput(input);
      } catch (err) {
        turnOpen = false;
        throw err;
      }
    },
    async steerUserInput(input: ModelUserInput): Promise<"accepted" | "deferred"> {
      assertOpen();
      if (query.ended) return "deferred";
      return (await query.steerUserInput?.(input)) ?? "deferred";
    },
    async interrupt(reason?: string): Promise<void> {
      await settled();
      interrupted = true;
      if (!query.ended) await query.interrupt(reason);
    },
    async close(): Promise<void> {
      closed = true;
      await settled();
      await query.close();
      void pumped.finally(() => outbox.end());
    },
  };
}
