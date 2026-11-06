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

import { isDeepStrictEqual } from "node:util";
import type {
  ModelSession,
  ModelSessionConfig,
  ModelSessionParams,
  ModelUserInput,
  ProviderId,
  ModelFunding,
} from "../../../domain/model-port.js";
import {
  createGeneratedImageTracker,
  createImageTraceSessionState,
  type ImageTraceSessionState,
  type ToolTraceState,
} from "./image-trace.js";
import { stripLegacyReasoningSuffix } from "./common.js";
import { AgentMessageSink } from "./session.js";
import type { CodexTurnRuntime } from "./turn-runtime.js";
import type { DynamicToolSpec } from "./app-server-protocol.js";
import { createRomeDynamicTools } from "./rome-dynamic-tools.js";

export interface BorrowedExactForkCompatibility {
  eligible: boolean;
  sameModel: boolean;
  sameSystemPrompt: boolean;
  sameWorkingDir: boolean;
  sameTools: boolean;
  sameTurnSettings: boolean;
}

/**
 * A borrowed turn runs on the source thread under the source's configuration,
 * so a turn can borrow it only when the branch opens with that same
 * configuration and catalog.
 */
export function evaluateBorrowedExactFork(args: {
  openParams: ModelSessionParams;
  sourceConfig: ModelSessionConfig;
  sourceDynamicTools: readonly DynamicToolSpec[];
}): BorrowedExactForkCompatibility {
  const branch = args.openParams.config;
  const source = args.sourceConfig;
  const sameModel =
    stripLegacyReasoningSuffix(branch.model) === stripLegacyReasoningSuffix(source.model);
  const sameSystemPrompt = branch.systemPrompt === source.systemPrompt;
  const sameWorkingDir =
    (branch.workingDir ?? process.cwd()) === (source.workingDir ?? process.cwd());
  const sameTools =
    isDeepStrictEqual(branch.builtinTools ?? [], source.builtinTools ?? []) &&
    isDeepStrictEqual(branch.externalMcpServers ?? {}, source.externalMcpServers ?? {}) &&
    isDeepStrictEqual(
      createRomeDynamicTools(args.openParams.tools).definitions,
      args.sourceDynamicTools,
    );
  const sameTurnSettings =
    branch.reasoningEffort === source.reasoningEffort &&
    isDeepStrictEqual(branch.outputSchema, source.outputSchema) &&
    isDeepStrictEqual(branch.env ?? {}, source.env ?? {});
  return {
    eligible: sameModel && sameSystemPrompt && sameWorkingDir && sameTools && sameTurnSettings,
    sameModel,
    sameSystemPrompt,
    sameWorkingDir,
    sameTools,
    sameTurnSettings,
  };
}

export interface CreateBorrowedExactForkSessionArgs {
  providerId: ProviderId;
  forkOwnerId: string;
  sourceThreadId: string;
  openParams: ModelSessionParams;
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
  runTurn(input: ModelUserInput, runtime: CodexTurnRuntime): Promise<void>;
  /** Called when the input is sent, before it waits behind the source's turns. */
  onSend?: (input: ModelUserInput) => void;
  revertTurn(threadId: string, beforeTurnId: string): Promise<void>;
  interrupt(reason?: string): Promise<void>;
  funding?: () => ModelFunding | undefined;
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
  // The run built the fork's tools with the interactive surface detached:
  // nothing drains this session's stream into webchat, so the interactive
  // tools take their non-interactive fallbacks while the advertised catalog
  // stays byte-identical to the source (prefix identity — the reason this
  // module exists). Flattening them here changes nothing in them.
  const romeTools = createRomeDynamicTools(args.openParams.tools);

  let closed = false;
  let closing = false;
  let inputSent = false;
  let runPromise: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | null = null;
  const runtime: CodexTurnRuntime = {
    ownerSessionId: args.forkOwnerId,
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
    model: args.openParams.config.model,
    events: sink.iter(),
    modelThreadId: args.sourceThreadId,
    get funding(): ModelFunding | undefined {
      return args.funding?.();
    },
    sendUserInput: async (input) => {
      if (closed || closing) throw new Error("ModelSession is closed");
      if (inputSent) throw new Error("Exact Codex forks support one turn");
      if (!input.text.trim()) throw new Error("Exact Codex forks require non-empty input");
      inputSent = true;
      args.onSend?.(input);
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
