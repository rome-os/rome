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

const log = createLogger("anthropic-reopening-session");

/** One Claude CLI process. `ended` once an interrupt or its stream has taken it down. */
export interface ClaudeQuerySession extends ModelSession {
  readonly ended: boolean;
}

function signal(): { fired: Promise<void>; fire(): void } {
  let fire!: () => void;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fired, fire };
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
  let drained = signal();
  let replaced = signal();

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

  const events: AsyncIterable<ModelSessionEvent> = (async function* () {
    try {
      while (!closed) {
        let failure: unknown;
        try {
          for await (const event of query.events) {
            if (event.type === "result" || event.type === "error") turnOpen = false;
            yield event;
          }
        } catch (err) {
          failure = err;
          log.warn("claude query stream failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (turnOpen) {
          turnOpen = false;
          yield lostTurnTerminal(failure);
        }
        drained.fire();
        await replaced.fired;
      }
    } finally {
      abandoned = true;
    }
  })();

  const reopen = (): Promise<void> => {
    reopening ??= (async () => {
      const ended = query;
      await ended.close();
      await drained.fired;
      const next = await open({
        ...params,
        thread: ended.modelThreadId
          ? { kind: "resume", modelThreadId: ended.modelThreadId }
          : params.thread,
      });
      query = next;
      drained = signal();
      const { fire } = replaced;
      replaced = signal();
      fire();
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
    get funding() {
      return query.funding;
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
      replaced.fire();
    },
  };
}
