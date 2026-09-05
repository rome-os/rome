// Temporary adapter for https://github.com/openai/codex/issues/24704.
//
// Codex app-server rebuilds a native thread/fork under fresh response
// continuation and prompt-cache lineage. The transcript is identical, but the
// inherited suffix is billed as uncached. For a same-configuration exact fork,
// Rome borrows the source thread for one serialized turn and rolls that turn
// back before publishing its terminal event.
//
// Once app-server preserves cache lineage natively, delete this module and the
// provider branch that calls it. The remaining workaround seams are deliberately
// easy to find: CodexTurnRuntime.beforeTerminal and Method.threadRevert.

import type {
  ModelSession,
  ModelSessionForkOpenParams,
  ModelSessionForkParams,
  ModelUserInput,
  ProviderId,
} from "../agent-runner.js";
import {
  createGeneratedImageTracker,
  createImageTraceSessionState,
  type ImageTraceSessionState,
  type ToolTraceState,
} from "./image-trace.js";
import { stripLegacyReasoningSuffix } from "./common.js";
import { AgentMessageSink } from "./session.js";
import type { CodexTurnRuntime } from "./turn-runtime.js";
import { createRomeDynamicTools } from "./rome-dynamic-tools.js";

export interface BorrowedExactForkCompatibility {
  eligible: boolean;
  sameModel: boolean;
  sameSystemPrompt: boolean;
  sameWorkingDir: boolean;
}

/**
 * Keep the workaround opt-in. Matching model/prompt/cwd is necessary but not
 * sufficient: isolated forks intentionally open a reduced tool surface, while
 * exact mode guarantees that the provider-visible configuration was copied
 * from the live source session by AgentSession.
 */
export function evaluateBorrowedExactFork(args: {
  forkParams: ModelSessionForkParams;
  openParams: ModelSessionForkOpenParams;
  sourceModelName: string;
  sourceSystemPrompt: string;
  sourceWorkingDir?: string;
}): BorrowedExactForkCompatibility {
  const sameModel = stripLegacyReasoningSuffix(args.openParams.model) === args.sourceModelName;
  const sameSystemPrompt = args.openParams.systemPrompt === args.sourceSystemPrompt;
  const sameWorkingDir =
    (args.openParams.workingDir ?? process.cwd()) === (args.sourceWorkingDir ?? process.cwd());
  return {
    eligible:
      args.forkParams.configurationMode === "exact" &&
      sameModel &&
      sameSystemPrompt &&
      sameWorkingDir,
    sameModel,
    sameSystemPrompt,
    sameWorkingDir,
  };
}

export interface CreateBorrowedExactForkSessionArgs {
  providerId: ProviderId;
  forkSessionId: string;
  sourceThreadId: string;
  openParams: ModelSessionForkOpenParams;
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
  runTurn(input: ModelUserInput, runtime: CodexTurnRuntime): Promise<void>;
  revertTurn(threadId: string, beforeTurnId: string): Promise<void>;
  interrupt(reason?: string): Promise<void>;
}

/** Build the ephemeral one-turn ModelSession used only by eligible exact forks. */
export async function createBorrowedExactForkSession(
  args: CreateBorrowedExactForkSessionArgs,
): Promise<ModelSession> {
  const sink = new AgentMessageSink();
  const imageTraceCtx: ToolTraceState & ImageTraceSessionState = {
    emittedToolUseIds: new Set(),
    ...createImageTraceSessionState(),
  };
  const imageTracker = await createGeneratedImageTracker();
  // Exact-fork open params carry interactiveSurfaceDetached: nothing drains
  // this session's stream into webchat, so the interactive tools must take
  // their non-interactive fallbacks while the advertised catalog stays
  // byte-identical to the source (prefix identity — the reason this module
  // exists). The shared mapping keeps that flag (and any future facade
  // capability) in lockstep with openSession's wiring.
  const romeTools = createRomeDynamicTools(args.openParams);

  let closed = false;
  let closing = false;
  let inputSent = false;
  let runPromise: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | null = null;
  const runtime: CodexTurnRuntime = {
    ownerSessionId: args.forkSessionId,
    sink,
    imageTraceCtx,
    imageTracker,
    romeTools,
    isClosed: () => closed,
    // Revert happens before the result/error event, so consumers can never
    // observe success while the source conversation still contains the turn.
    beforeTerminal: async ({ threadId, turnId }) => await args.revertTurn(threadId, turnId),
  };

  return {
    providerId: args.providerId,
    model: args.openParams.model,
    events: sink.iter(),
    providerThreadId: args.sourceThreadId,
    sendUserInput: async (input) => {
      if (closed || closing) throw new Error("ModelSession is closed");
      if (inputSent) throw new Error("Exact Codex forks support one turn");
      if (!input.text.trim()) throw new Error("Exact Codex forks require non-empty input");
      inputSent = true;
      runPromise = args
        .runExclusive(async () => await args.runTurn(input, runtime))
        .catch((err) => {
          if (!closed) {
            sink.push({
              type: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
    },
    fork: async () => {
      throw new Error("Nested exact Codex forks are not supported");
    },
    interrupt: args.interrupt,
    close: async () => {
      if (closePromise) return await closePromise;
      closePromise = (async () => {
        closing = true;
        await runPromise;
        closed = true;
        sink.end();
      })();
      await closePromise;
    },
  };
}
