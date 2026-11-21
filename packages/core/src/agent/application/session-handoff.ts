// Writes a renewal's handoff: one private turn on the retired session's
// thread, or on a branch of it, with no tools, and a small model over the
// chat's messages when that turn fails or takes too long.
// docs/concepts/sessions.md#handoff

import type { AgentLog } from "../domain/agent-log.js";
import type { ModelSession, ProviderId, ThreadStart } from "../domain/model-port.js";
import { NO_ROME_TOOLS } from "../domain/rome-tools.js";
import type { Session } from "../domain/session.js";
import {
  HANDOFF_REQUEST,
  HANDOFF_TURN_INSTRUCTION,
  type RenewalHandoffs,
} from "../domain/session-handoff.js";
import type { TurnUsageReporting } from "../domain/turn-usage-reporting.js";
import type { ModelResolver } from "./model-resolver.js";

export interface WriteHandoffInput {
  retired: Session;
  agentName: string;
  /** The chat the session serves, when it serves one. */
  chatId: string | undefined;
  /** The system prompt the retired thread resumes with: the setup as it is now. */
  systemPrompt: string;
  /** Where the retired thread resumes when it recorded no folder. */
  workingDir: string;
  env: Record<string, string | undefined>;
  /**
   * Where the handoff turn runs: by default the retired thread, resumed. A
   * branch keeps the thread itself from reading the request, for a session
   * that stays live. Null asks the fallback alone.
   */
  thread?: ThreadStart | null;
  /** Written while the chat goes on, so the chat does not say it is tidying up. */
  background?: boolean;
  /** Drops the handoff as stale: the turn is stopped and the fallback not asked. */
  signal?: AbortSignal;
}

export interface WriteHandoffDeps {
  handoffs: RenewalHandoffs;
  modelResolver: ModelResolver;
  turnUsage: Pick<TurnUsageReporting, "modelTurnAccounted">;
  log: AgentLog;
}

class HandoffTimeout extends Error {
  constructor(ms: number) {
    super(`The retired session wrote no handoff within ${ms} ms`);
    this.name = "HandoffTimeout";
  }
}

class HandoffDropped extends Error {
  constructor() {
    super("The handoff was dropped as stale");
    this.name = "HandoffDropped";
  }
}

/**
 * The retired session's handoff: by the retired session itself within
 * `handoffs.timeoutMs`, else by the fallback. Unless written in the
 * background, the chat says it is tidying up meanwhile. Null when neither
 * wrote one, so the renewal goes on without it, or when `signal` dropped it.
 * Never throws.
 */
export async function writeRenewalHandoff(
  input: WriteHandoffInput,
  deps: WriteHandoffDeps,
): Promise<string | null> {
  const started = Date.now();
  const work = async (): Promise<string | null> => {
    if (input.thread !== null) {
      try {
        const handoff = await askRetiredSession(input, deps);
        deps.log.info("session_handoff.written", {
          agentName: input.agentName,
          oldSessionId: input.retired.id,
          by: "retired_session",
          durationMs: Date.now() - started,
          length: handoff.length,
        });
        return handoff;
      } catch (err) {
        if (err instanceof HandoffDropped || input.signal?.aborted) return null;
        deps.log.warn("session_handoff.retired_session_failed", {
          agentName: input.agentName,
          oldSessionId: input.retired.id,
          timedOut: err instanceof HandoffTimeout,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      const handoff = await deps.handoffs.fallback(input.chatId, input.agentName);
      if (input.signal?.aborted) return null;
      deps.log.info("session_handoff.written", {
        agentName: input.agentName,
        oldSessionId: input.retired.id,
        by: handoff ? "fallback" : "none",
        durationMs: Date.now() - started,
        length: handoff?.length ?? 0,
      });
      return handoff;
    } catch (err) {
      deps.log.warn("session_handoff.fallback_failed", {
        agentName: input.agentName,
        oldSessionId: input.retired.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
  return input.background ? await work() : await deps.handoffs.tidying(input.chatId, work);
}

/**
 * One turn on the retired session's thread, or a branch of it, on the model
 * that wrote it and with no tools, asking for the handoff. A resumed thread is
 * retired, so nothing resumes it after this turn.
 */
async function askRetiredSession(
  input: WriteHandoffInput,
  deps: WriteHandoffDeps,
): Promise<string> {
  const { retired, signal } = input;
  if (!retired.provider || !retired.modelThreadId || !retired.model) {
    throw new Error("The retired session has no model thread to resume");
  }
  if (signal?.aborted) throw new HandoffDropped();
  const thread: ThreadStart = input.thread ?? {
    kind: "resume",
    modelThreadId: retired.modelThreadId,
  };
  const timeoutMs = deps.handoffs.timeoutMs;
  let session: ModelSession | null = null;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const turn = (async () => {
    const resolution = await deps.modelResolver.resolve({
      kind: "exact",
      providerId: retired.provider as ProviderId,
      model: retired.model as string,
    });
    if (resolution.modelProvider.id !== retired.provider) {
      throw new Error(`The retired session's provider ${retired.provider} cannot run now`);
    }
    const opened = await resolution.modelProvider.openSession({
      config: {
        model: resolution.model,
        systemPrompt: `${input.systemPrompt}\n\n${HANDOFF_TURN_INSTRUCTION}`,
        builtinTools: [],
        reasoningEffort: "low",
        workingDir: retired.workingDir ?? input.workingDir,
        env: { ...input.env },
      },
      tools: NO_ROME_TOOLS,
      thread,
    });
    session = opened;
    if (finished) {
      // The deadline passed, or the handoff was dropped, while the thread
      // opened, and closed nothing.
      await opened.close().catch(() => undefined);
      throw signal?.aborted ? new HandoffDropped() : new HandoffTimeout(timeoutMs);
    }
    await opened.sendUserInput({ text: HANDOFF_REQUEST, reasoningEffort: "low" });
    for await (const event of opened.events) {
      if (event.type === "result" || event.type === "error") {
        deps.turnUsage.modelTurnAccounted(event.accounting, { agentName: input.agentName });
      }
      if (event.type === "error") throw new Error(event.error);
      if (event.type !== "result") continue;
      const text = event.content.trim();
      if (!text) throw new Error("The retired session wrote an empty handoff");
      return text;
    }
    throw new Error("The retired session ended without a handoff");
  })();
  const stop = (reason: string, error: Error, reject: (err: Error) => void) => {
    finished = true;
    void (session as ModelSession | null)?.interrupt(reason).catch(() => undefined);
    reject(error);
  };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => stop("handoff timed out", new HandoffTimeout(timeoutMs), reject),
      timeoutMs,
    );
    if (signal) {
      onAbort = () => stop("handoff dropped", new HandoffDropped(), reject);
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([turn, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    finished = true;
    turn.catch(() => undefined);
    deadline.catch(() => undefined);
    // Not awaited: a close that stalls, as a provider's may while a turn
    // drains, must not hold the renewal past its deadline.
    void (session as ModelSession | null)?.close().catch(() => undefined);
  }
}
