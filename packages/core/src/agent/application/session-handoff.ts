// Writes a renewal's handoff: one private turn on the retired session's own
// thread, with no tools, and a small model over the chat's messages when that
// turn fails or takes too long. docs/concepts/sessions.md#handoff

import type { AgentLog } from "../domain/agent-log.js";
import type { ModelSession, ProviderId } from "../domain/model-port.js";
import { NO_ROME_TOOLS } from "../domain/rome-tools.js";
import type { Session } from "../domain/session.js";
import { HANDOFF_REQUEST, type RenewalHandoffs } from "../domain/session-handoff.js";
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

/**
 * The retired session's handoff, written while the chat says it is tidying
 * up: by the retired session itself within `handoffs.timeoutMs`, else by the
 * fallback. Null when neither wrote one, so the renewal goes on without it.
 * Never throws.
 */
export async function writeRenewalHandoff(
  input: WriteHandoffInput,
  deps: WriteHandoffDeps,
): Promise<string | null> {
  const started = Date.now();
  return deps.handoffs.tidying(input.chatId, async () => {
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
      deps.log.warn("session_handoff.retired_session_failed", {
        agentName: input.agentName,
        oldSessionId: input.retired.id,
        timedOut: err instanceof HandoffTimeout,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      const handoff = await deps.handoffs.fallback(input.chatId, input.agentName);
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
  });
}

/**
 * One turn on the retired session's thread, resumed on the model that wrote
 * it and with no tools, asking for the handoff. The thread is retired, so
 * nothing resumes it after this turn.
 */
async function askRetiredSession(
  input: WriteHandoffInput,
  deps: WriteHandoffDeps,
): Promise<string> {
  const { retired } = input;
  if (!retired.provider || !retired.modelThreadId || !retired.model) {
    throw new Error("The retired session has no model thread to resume");
  }
  const timeoutMs = deps.handoffs.timeoutMs;
  let session: ModelSession | null = null;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
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
        systemPrompt: input.systemPrompt,
        builtinTools: [],
        reasoningEffort: "low",
        workingDir: retired.workingDir ?? input.workingDir,
        env: { ...input.env },
      },
      tools: NO_ROME_TOOLS,
      thread: { kind: "resume", modelThreadId: retired.modelThreadId as string },
    });
    session = opened;
    if (finished) {
      // The deadline passed while the thread opened, and closed nothing.
      await opened.close().catch(() => undefined);
      throw new HandoffTimeout(timeoutMs);
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
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      finished = true;
      void (session as ModelSession | null)?.interrupt("handoff timed out").catch(() => undefined);
      reject(new HandoffTimeout(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([turn, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    finished = true;
    turn.catch(() => undefined);
    await (session as ModelSession | null)?.close().catch(() => undefined);
  }
}
