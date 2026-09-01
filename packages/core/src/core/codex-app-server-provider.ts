// CodexAppServerProvider — the "openai" provider over the codex app-server
// JSON-RPC protocol. This is the only Codex surface (wired in index.ts); shared
// model/env/auth/accounting helpers live in codex/common.ts.
//
// The app-server exposes `agentMessage.phase` (commentary | final_answer) and
// `item/agentMessage/delta` streaming. Mapping `phase` → AgentMessage
// `turnPhase` promotes Codex in-turn commentary into the answer flow,
// consumed by the same UI that serves Anthropic. See
// KEEP-INTURN-TEXT-RESEARCH.md §6/§7.
//
// The JSON-RPC transport lives in app-server-client.ts; the
// notification→AgentMessage translation is below. Headless config:
// sandbox=danger-full-access + approvalPolicy=never, so Rome's per-action
// approval gate (inside the Rome tool facade) is the only gate and no server→client
// approval round-trips are needed.

import { DEFAULT_REASONING_EFFORT } from "@rome-os/app-runtime";
import type {
  ModelProvider,
  ModelReasoningEffort,
  ModelSession,
  ModelSessionForkOpenParams,
  ModelSessionFork,
  ModelSessionForkParams,
  ModelSessionParams,
  ModelUserInput,
  ProviderId,
} from "./agent-runner.js";
import {
  createBorrowedExactForkSession,
  evaluateBorrowedExactFork,
} from "./codex/borrowed-exact-fork.js";
import { AgentMessageSink, SerialTurnCoordinator, TurnDispatcher } from "./codex/session.js";
import {
  createGeneratedImageTracker,
  createImageTraceSessionState,
  translateImageGenerationStarted,
  translateImageGenerationCompleted,
  type GeneratedImageTracker,
  type ImageTraceSessionState,
  type ToolTraceState,
} from "./codex/image-trace.js";
import { CodexAppServerManager, type CodexThreadBinding } from "./codex/app-server-manager.js";
import {
  Method,
  Notify,
  isAgentMessageItem,
  isReasoningItem,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type AgentMessageDeltaNotification,
  type MessagePhase,
  type ReasoningEffort,
  type ThreadItem,
  type ThreadStartParams,
  type TokenUsageBreakdown,
  type ThreadTokenUsage,
  type ThreadTokenUsageUpdatedNotification,
  type TurnCompletedNotification,
  type TurnPlanUpdatedNotification,
  type TurnStartedNotification,
  type ErrorNotification,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
} from "./codex/app-server-protocol.js";
import { buildTurnInput } from "./codex/turn-input.js";
import {
  buildOpenAiAccounting,
  calculateOpenAiCostUsd,
  stripLegacyReasoningSuffix,
  type Usage,
} from "./codex/common.js";
import type { AgentMessage, AgentPlan, AgentPlanStepStatus } from "../types.js";
import { codexTurnErrorMessage, isCodexUsageLimitError } from "./codex-usage-limit.js";
import { CODEX_AUTH_REVOKED_CODE, isCodexAuthRevokedError } from "./codex-auth-revoked.js";
import { markCodexAuthRevoked } from "../lib/codex-cli-auth.js";
import { createLogger } from "../logger.js";
import type { CodexTurnRuntime } from "./codex/turn-runtime.js";
import { createRomeDynamicTools, type RomeDynamicTools } from "./codex/rome-dynamic-tools.js";
import {
  compileOutputSchema,
  formatOutputSchemaErrors,
} from "../apps/packaging/output-schema-validator.js";

const log = createLogger("codex-app-server-provider");

const DEFAULT_EFFORT: ReasoningEffort = DEFAULT_REASONING_EFFORT;
const VALID_EFFORTS: ReadonlySet<string> = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function normalizeEffort(effort: ModelReasoningEffort | undefined): ReasoningEffort {
  if (typeof effort === "string" && VALID_EFFORTS.has(effort)) return effort as ReasoningEffort;
  return DEFAULT_EFFORT;
}

function buildThreadConfig(
  params: ModelSessionForkOpenParams,
  model: string,
  romeTools: RomeDynamicTools,
): ThreadStartParams {
  const config: Record<string, unknown> = {
    model_reasoning_summary: "detailed",
    hide_agent_reasoning: false,
  };
  if (params.externalMcpServers && Object.keys(params.externalMcpServers).length > 0) {
    config.mcp_servers = params.externalMcpServers;
  }
  return {
    model,
    cwd: params.workingDir ?? null,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
    baseInstructions: params.systemPrompt,
    config,
    dynamicTools: romeTools.definitions.length > 0 ? [...romeTools.definitions] : null,
  };
}

/** commentary → "commentary"; final_answer → "final"; null/absent → undefined
 *  (legacy model / phase unknown → not promoted by the UI). */
function mapPhase(phase: MessagePhase | null | undefined): "commentary" | "final" | undefined {
  if (phase === "commentary") return "commentary";
  if (phase === "final_answer") return "final";
  return undefined;
}

function normalizeCodexPlanUpdate(params: unknown): AgentPlan | null {
  const raw = params as Partial<TurnPlanUpdatedNotification> | undefined;
  if (!Array.isArray(raw?.plan)) return null;

  const steps: AgentPlan["steps"] = [];
  for (const candidate of raw.plan as unknown[]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const step = candidate as { step?: unknown; status?: unknown };
    const text = typeof step.step === "string" ? step.step.trim() : "";
    if (!text) continue;
    let status: AgentPlanStepStatus | undefined;
    if (step.status === "pending" || step.status === "completed") status = step.status;
    if (step.status === "inProgress") status = "in_progress";
    if (!status) continue;
    steps.push({ text, status });
  }

  // A provider-authored empty list explicitly clears the Plan. A malformed
  // non-empty list must not erase the last valid snapshot.
  if (raw.plan.length > 0 && steps.length === 0) return null;
  const explanation = typeof raw.explanation === "string" ? raw.explanation.trim() : undefined;
  return {
    ...(explanation ? { explanation } : {}),
    steps,
  };
}

// App-server item types that represent an actual tool call. Everything else
// (userMessage echo, hookPrompt, plan, todoList, …) is not a tool and must not
// be emitted as one — it would pollute the trace and confuse pairing.
const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "mcpToolCall",
  "dynamicToolCall",
  "commandExecution",
  "fileChange",
  "webSearch",
]);

/** Rome-facing tool label for a non-message app-server item. Keeps the trace
 *  readable; the raw item payload rides along as input/output. */
function toolNameForItem(item: ThreadItem): string {
  switch (item.type) {
    case "commandExecution":
      return "Bash";
    case "fileChange":
      return "Edit";
    case "webSearch":
      return "WebSearch";
    case "mcpToolCall": {
      const tool = (item as { tool?: unknown }).tool;
      return typeof tool === "string" ? tool : "mcp_tool";
    }
    case "dynamicToolCall": {
      const tool = (item as { tool?: unknown }).tool;
      return typeof tool === "string" ? tool : "dynamic_tool";
    }
    default:
      return item.type;
  }
}

function notificationTokenUsage(
  notification: ThreadTokenUsageUpdatedNotification,
): ThreadTokenUsage | undefined {
  return notification.tokenUsage ?? notification.usage;
}

/** App-server token usage (camelCase) → the snake_case shape buildOpenAiAccounting reads. */
function toSdkUsage(u: TokenUsageBreakdown | undefined): Usage | undefined {
  if (!u) return undefined;
  return {
    input_tokens: u.inputTokens,
    cached_input_tokens: u.cachedInputTokens,
    output_tokens: u.outputTokens,
    reasoning_output_tokens: u.reasoningOutputTokens,
    total_tokens: u.totalTokens,
  } as unknown as Usage;
}

function tokenUsageBreakdownEquals(left: TokenUsageBreakdown, right: TokenUsageBreakdown): boolean {
  return (
    left.totalTokens === right.totalTokens &&
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningOutputTokens === right.reasoningOutputTokens
  );
}

/**
 * Codex reports both cumulative thread usage (`total`) and only the latest
 * model request (`last`). A Rome turn can contain many model requests as the
 * agent calls tools, so accounting must sum every `last` notification in the
 * turn instead of replacing the prior value with the newest one.
 */
function updateTurnUsage(turn: ActiveTurn, update: ThreadTokenUsage): void {
  const last = update.last;
  const usage = turn.usage;
  turn.usage = usage
    ? {
        totalTokens: usage.totalTokens + last.totalTokens,
        inputTokens: usage.inputTokens + last.inputTokens,
        cachedInputTokens: usage.cachedInputTokens + last.cachedInputTokens,
        outputTokens: usage.outputTokens + last.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens + last.reasoningOutputTokens,
      }
    : last;
  turn.requestUsages.push(last);
}

function calculateTurnCostUsd(usages: TokenUsageBreakdown[], model: string): number | undefined {
  if (usages.length === 0) return undefined;
  let total = 0;
  for (const usage of usages) {
    const cost = calculateOpenAiCostUsd(toSdkUsage(usage), model);
    if (cost === undefined) return undefined;
    total += cost;
  }
  return total;
}

interface ActiveTurn {
  ownerSessionId: string;
  sink: AgentMessageSink;
  imageTraceCtx: ToolTraceState & ImageTraceSessionState;
  imageTracker: GeneratedImageTracker;
  romeTools: RomeDynamicTools;
  turnId: string | null;
  initialInputId?: string;
  completed: boolean;
  /** Usage accumulated across every model request in this Rome turn. */
  usage?: TokenUsageBreakdown;
  /** Per-request usage retained so non-linear pricing is applied correctly. */
  requestUsages: TokenUsageBreakdown[];
  finalText: string;
  startedAt: number;
  /** Resolves when turn/completed (or a terminal error) lands. */
  done: Promise<void>;
  resolveDone: () => void;
  toolStarted: Set<string>;
  /** Async image-generation trace work. `imageGeneration` item/completed reads
   *  the image (inline or off disk) to build the tool_result, so the push is
   *  deferred; awaited before the terminal block so generated images land in
   *  the trace ahead of the turn-closing `result`. */
  pending: Promise<void>[];
  /** Terminal disposition recorded by turn/completed (or a terminal error) and
   *  applied once in runOne, after image work drains. `errorMessage` non-null
   *  means the turn ends with an `error` block instead of a `result`. */
  failed: boolean;
  errorMessage: string | null;
  /** Set to `"usage_limit"` (exhausted codex quota) or `"auth_revoked"` (the
   *  stored credentials were revoked server-side) so the terminal `error` block
   *  can carry the classification for state refresh and UI handling. */
  errorCode: "usage_limit" | "auth_revoked" | null;
}

interface CodexAppServerProviderOptions {
  appServerManager?: CodexAppServerManager;
  /** Update runtime auth state before an auth-revoked terminal is exposed. */
  onAuthRevoked?: () => Promise<void> | void;
  /** Mark quota before the usage-limit terminal is exposed to AgentSession. */
  onQuotaExhausted?: () => void;
}

interface CodexFailureClassification {
  code: "usage_limit" | "auth_revoked" | null;
  pending?: Promise<void>;
}

async function persistCodexAuthRevoked(
  onAuthRevoked: CodexAppServerProviderOptions["onAuthRevoked"],
): Promise<void> {
  try {
    await markCodexAuthRevoked();
  } catch (err) {
    log.warn("failed to persist codex auth-revoked marker", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await onAuthRevoked?.();
  } catch (err) {
    log.warn("failed to update AI tool state after codex auth revocation", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Classify a failed codex turn's error into the terminal `ErrorMessage.code`.
 * Usage-limit takes precedence — an exhausted quota is not an auth problem. A
 * revoked credential additionally persists the marker that downgrades the
 * settings badge to "needs re-login" (best-effort; see `markCodexAuthRevoked`).
 */
function classifyCodexFailure(
  turnError: unknown,
  options: CodexAppServerProviderOptions,
): CodexFailureClassification {
  if (isCodexUsageLimitError(turnError)) {
    options.onQuotaExhausted?.();
    return { code: "usage_limit" };
  }
  if (isCodexAuthRevokedError(turnError)) {
    return {
      code: CODEX_AUTH_REVOKED_CODE,
      pending: persistCodexAuthRevoked(options.onAuthRevoked),
    };
  }
  return { code: null };
}

export class CodexAppServerProvider implements ModelProvider {
  readonly id: ProviderId = "openai";
  readonly displayName = "Codex (ChatGPT)";
  // Match the exec provider / Anthropic set so agent yamls are provider-agnostic.
  readonly builtinTools: ReadonlySet<string> = new Set([
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "TodoWrite",
    "Task",
  ]);

  private readonly appServerManager: CodexAppServerManager;

  constructor(private readonly options: CodexAppServerProviderOptions = {}) {
    this.appServerManager = options.appServerManager ?? new CodexAppServerManager();
    void this.appServerManager.warmup().catch((err) => {
      log.warn("codex app-server warmup failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  close(): void {
    this.appServerManager.close();
  }

  async openSession(params: ModelSessionParams): Promise<ModelSession> {
    const modelName = stripLegacyReasoningSuffix(params.model);
    const outputValidator = params.outputSchema
      ? compileOutputSchema(params.outputSchema)
      : undefined;

    // Rome-owned actions, skills, subagents, and interactive tools use
    // app-server dynamic tools. The provider-visible catalog is thread-scoped;
    // execution is selected from the active turn runtime so a borrowed exact
    // fork can reuse the source thread with fork callbacks.
    const romeTools = createRomeDynamicTools(params);

    const sink = new AgentMessageSink();
    // Image-generation trace. The app-server delivers it as `imageGeneration`
    // thread items (inline `result` + `savedPath`); a filesystem tracker over
    // ~/.codex/generated_images backstops any image codex writes without an
    // item. Both paths share one dedup set (keyed by saved path) so an image is
    // emitted at most once. Same translators the exec provider uses, so the
    // trace shows an identical ImageGeneration tool_use/tool_result.
    const imageTraceCtx: ToolTraceState & ImageTraceSessionState = {
      emittedToolUseIds: new Set(),
      ...createImageTraceSessionState(),
    };
    // Scoped to this session's thread dir (assigned on openThread below,
    // before any turn runs) so concurrent sessions never pick up each other's
    // generated images.
    let threadId: string | null = null;
    const imageTracker: GeneratedImageTracker = await createGeneratedImageTracker({
      getThreadId: () => threadId ?? undefined,
    });
    let closed = false;
    let closing = false;
    // Set when a borrowed exact-fork turn could not be rolled back off the
    // source thread: from then on the thread history permanently contains the
    // fork's turn, so letting any further turn or fork run from it would
    // silently break exact-fork isolation. Never cleared — the session must
    // be replaced.
    let contaminatedReason: string | null = null;
    let activeTurn: ActiveTurn | null = null;
    let sourceStarted: Promise<void> = Promise.resolve();
    let resolveSourceStarted: (() => void) | undefined;
    let lastCompletedTurnCheckpoint: string | undefined;
    const dynamicToolOutputs = new Map<string, unknown>();
    const usageByTurnId = new Map<
      string,
      { usage: ThreadTokenUsage; hasNewRequestUsage: boolean }
    >();
    const lastCumulativeUsageByThreadId = new Map<string, TokenUsageBreakdown>();

    const session: ModelSession = {
      providerId: this.id,
      model: params.model,
      events: sink.iter(),
      providerThreadId: params.providerThreadId,
      get lastCompletedTurnCheckpoint(): string | undefined {
        return lastCompletedTurnCheckpoint;
      },
    } as ModelSession;

    const onItem = (item: ThreadItem, lifecycle: "started" | "completed"): void => {
      const turnSink = activeTurn?.sink ?? sink;
      if (item.type === "userMessage" && lifecycle === "completed") {
        const clientId = (item as { clientId?: unknown }).clientId;
        if (typeof clientId === "string") {
          if (
            activeTurn?.ownerSessionId === params.sessionId &&
            clientId === activeTurn.initialInputId
          )
            resolveSourceStarted?.();
          turnSink.push({ type: "input_status", inputId: clientId, state: "consumed" });
        }
        return;
      }
      const turnImageTraceCtx = activeTurn?.imageTraceCtx ?? imageTraceCtx;
      if (isAgentMessageItem(item)) {
        if (lifecycle !== "completed") return;
        if (!item.text) return;
        const turnPhase = mapPhase(item.phase);
        // The final answer is carried by the terminal `result` block; commentary
        // is promoted by the UI. (Anthropic provider mirrors this split.)
        if (turnPhase === "final" || item.phase == null) {
          if (activeTurn) activeTurn.finalText = item.text;
        }
        if (params.outputSchema) return;
        const msg: AgentMessage = turnPhase
          ? { type: "text", content: item.text, turnPhase }
          : { type: "text", content: item.text };
        turnSink.push(msg);
        return;
      }
      if (isReasoningItem(item)) {
        if (lifecycle !== "completed") return;
        const text = [...item.summary, ...item.content].filter(Boolean).join("\n").trim();
        if (text) turnSink.push({ type: "thinking", content: text });
        return;
      }
      // Image generation: the `imageGeneration` item carries the inline image
      // (`result`) and on-disk path (`savedPath`). The completed translator is
      // async (it may read the image off disk), so defer its push onto the
      // turn's pending set — runOne awaits it before the terminal block.
      if (item.type === "imageGeneration") {
        if (lifecycle === "started") {
          for (const m of translateImageGenerationStarted(item, turnImageTraceCtx))
            turnSink.push(m);
          return;
        }
        const work = translateImageGenerationCompleted(item, turnImageTraceCtx)
          .then((msgs) => {
            for (const m of msgs) turnSink.push(m);
          })
          .catch((err) => {
            log.warn("codex image generation trace failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        if (activeTurn) activeTurn.pending.push(work);
        return;
      }
      // Tool calls: tool_use on start, tool_result on completion. Non-tool
      // items (userMessage echo, plan, todoList, …) are skipped.
      if (!TOOL_ITEM_TYPES.has(item.type)) return;
      const tool = toolNameForItem(item);
      // External MCP tools arrive as `mcpToolCall`, which nests the real result
      // in `item.result`. Rome-owned tools arrive as `dynamicToolCall` and use
      // the in-process facade output retained by callId. Normalize both so the
      // drain loop sees the real args/result rather than the wrapper item.
      const isMcp = item.type === "mcpToolCall";
      const isDynamic = item.type === "dynamicToolCall";
      const rec = item as {
        arguments?: unknown;
        result?: unknown;
        error?: unknown;
        contentItems?: unknown;
      };
      if (lifecycle === "started") {
        if (activeTurn?.toolStarted.has(item.id)) return;
        activeTurn?.toolStarted.add(item.id);
        turnSink.push({
          type: "tool_use",
          id: item.id,
          tool,
          input: isMcp || isDynamic ? (rec.arguments ?? item) : item,
          startedAt: new Date().toISOString(),
        });
        return;
      }
      const dynamicOutput = isDynamic ? dynamicToolOutputs.get(item.id) : undefined;
      if (isDynamic) dynamicToolOutputs.delete(item.id);
      turnSink.push({
        type: "tool_result",
        toolUseId: item.id,
        tool,
        output: isDynamic
          ? (dynamicOutput ?? rec.contentItems ?? rec.error ?? item)
          : isMcp
            ? (rec.result ?? rec.error ?? item)
            : item,
        endedAt: new Date().toISOString(),
      });
    };

    const onNotification = (method: string, params2: unknown): void => {
      switch (method) {
        case Notify.turnStarted: {
          const p = params2 as TurnStartedNotification;
          if (activeTurn) {
            if (activeTurn.turnId && activeTurn.turnId !== p.turn?.id) return;
            activeTurn.turnId = p.turn?.id ?? null;
            const update = activeTurn.turnId ? usageByTurnId.get(activeTurn.turnId) : undefined;
            if (update?.hasNewRequestUsage) updateTurnUsage(activeTurn, update.usage);
          }
          return;
        }
        case Notify.turnPlanUpdated: {
          const p = params2 as Partial<TurnPlanUpdatedNotification>;
          if (
            !activeTurn ||
            !threadId ||
            p.threadId !== threadId ||
            !activeTurn.turnId ||
            p.turnId !== activeTurn.turnId
          ) {
            return;
          }
          const plan = normalizeCodexPlanUpdate(params2);
          if (!plan) {
            log.warn("skipping malformed codex plan update", {
              threadId: p.threadId,
              turnId: p.turnId,
            });
            return;
          }
          activeTurn.sink.push({ type: "plan_update", plan });
          return;
        }
        case Notify.agentMessageDelta: {
          const p = params2 as AgentMessageDeltaNotification;
          if (!activeTurn || (activeTurn.turnId && activeTurn.turnId !== p.turnId)) return;
          if (p.delta && !params.outputSchema)
            (activeTurn?.sink ?? sink).push({ type: "text_delta", content: p.delta });
          return;
        }
        case Notify.itemStarted: {
          const p = params2 as ItemStartedNotification;
          if (!activeTurn || (activeTurn.turnId && activeTurn.turnId !== p.turnId)) return;
          onItem(p.item, "started");
          return;
        }
        case Notify.itemCompleted: {
          const p = params2 as ItemCompletedNotification;
          if (!activeTurn || (activeTurn.turnId && activeTurn.turnId !== p.turnId)) return;
          onItem(p.item, "completed");
          return;
        }
        case Notify.tokenUsageUpdated: {
          const p = params2 as ThreadTokenUsageUpdatedNotification;
          const usage = notificationTokenUsage(p);
          if (!usage) return;
          // Once turn/started establishes the active id, a delayed snapshot
          // from another turn must not reset this thread's cumulative
          // baseline. Keep accepting updates while the id is still null so
          // notifications that race ahead of turn/started remain buffered.
          if (p.turnId && activeTurn?.turnId && activeTurn.turnId !== p.turnId) return;
          const previousTotal = lastCumulativeUsageByThreadId.get(p.threadId);
          const hasNewRequestUsage =
            previousTotal === undefined || !tokenUsageBreakdownEquals(previousTotal, usage.total);
          lastCumulativeUsageByThreadId.set(p.threadId, usage.total);
          if (p.turnId) {
            usageByTurnId.set(p.turnId, { usage, hasNewRequestUsage });
            if (hasNewRequestUsage && activeTurn?.turnId === p.turnId) {
              updateTurnUsage(activeTurn, usage);
            }
            return;
          }
          // Compatibility for early app-server stubs that omitted turnId.
          if (hasNewRequestUsage && activeTurn) updateTurnUsage(activeTurn, usage);
          return;
        }
        case Notify.turnCompleted: {
          // Record the disposition and resolve the turn; the terminal block is
          // emitted in runOne after pending image work drains (the agent
          // session closes the turn sink on the first result/error, so nothing
          // pushed after it survives).
          const p = params2 as TurnCompletedNotification;
          if (activeTurn) {
            if (activeTurn.turnId && activeTurn.turnId !== p.turn?.id) return;
            activeTurn.completed = true;
            if (p.turn?.status === "failed") {
              // `turn.error` is a structured `TurnError` object (camelCase),
              // not a string — extract the human message and classify quota
              // exhaustion / revoked credentials off it.
              activeTurn.failed = true;
              activeTurn.errorMessage = codexTurnErrorMessage(p.turn?.error, "codex turn failed");
              const classification = classifyCodexFailure(p.turn?.error, this.options);
              activeTurn.errorCode = classification.code;
              if (classification.pending) activeTurn.pending.push(classification.pending);
            } else if (params.outputSchema && p.turn?.status !== "completed") {
              activeTurn.failed = true;
              activeTurn.errorMessage = `Codex app-server structured turn ended with status ${p.turn?.status ?? "unknown"}`;
            }
            activeTurn.resolveDone();
          }
          return;
        }
        case Notify.error: {
          const p = params2 as ErrorNotification;
          if (p.willRetry) return;
          if (p.turnId && (!activeTurn || (activeTurn.turnId && activeTurn.turnId !== p.turnId))) {
            return;
          }
          // v2 wraps the structured TurnError under `error`; tolerate older
          // shapes that put `message` at the top level.
          const payload = p.error ?? (params2 as { message?: unknown });
          const message = codexTurnErrorMessage(payload, "codex app-server error");
          const classification = classifyCodexFailure(payload, this.options);
          const code = classification.code;
          if (activeTurn) {
            // Route the terminal through runOne (see turn/completed).
            activeTurn.completed = true;
            activeTurn.failed = true;
            activeTurn.errorMessage = message;
            activeTurn.errorCode = code;
            if (classification.pending) activeTurn.pending.push(classification.pending);
            activeTurn.resolveDone();
          } else {
            if (classification.pending) void classification.pending;
            // Out-of-turn error: no turn to attach to, emit directly.
            sink.push(
              code ? { type: "error", error: message, code } : { type: "error", error: message },
            );
          }
          return;
        }
        default:
          return;
      }
    };

    const onDynamicToolCall = async (
      call: DynamicToolCallParams,
    ): Promise<DynamicToolCallResponse> => {
      const turn = activeTurn;
      if (!turn) {
        return {
          contentItems: [
            { type: "inputText", text: "Dynamic tool call received outside an active turn" },
          ],
          success: false,
        };
      }
      if (turn.turnId && call.turnId !== turn.turnId) {
        return {
          contentItems: [
            {
              type: "inputText",
              text: `Dynamic tool call turn mismatch: ${call.turnId}`,
            },
          ],
          success: false,
        };
      }
      const result = await turn.romeTools.callTool(call.tool, call.arguments, {
        toolUseId: call.callId,
      });
      dynamicToolOutputs.set(call.callId, result.traceOutput);
      return result.response;
    };

    const binding: CodexThreadBinding = {
      onNotification,
      onDynamicToolCall,
      onExit: () => {
        if (closed) return;
        const turn = activeTurn;
        if (!turn) return;
        // Exit after turn/start was acknowledged means turn/completed will
        // never arrive. Settle exactly this active turn; idle sessions retain
        // their thread configuration and lazily resume on their next turn.
        turn.failed = true;
        turn.errorMessage ??= "codex app-server exited";
        turn.resolveDone();
      },
    };

    const threadConfig = buildThreadConfig(params, modelName, romeTools);

    threadId = await this.appServerManager.openThread(
      threadConfig,
      binding,
      params.isNewSession === false ? params.providerThreadId : undefined,
    );
    session.providerThreadId = threadId;

    const sourceRuntime: CodexTurnRuntime = {
      ownerSessionId: params.sessionId,
      sink,
      imageTraceCtx,
      imageTracker,
      romeTools,
      isClosed: () => closed,
    };

    // The source dispatcher and exact forks share one app-server thread. Keep
    // all turns serialized so a hidden exact turn cannot interleave with a
    // normal source turn while its dynamic callbacks and event sink are borrowed.
    const turnCoordinator = new SerialTurnCoordinator();

    const runOne = async (inputs: ModelUserInput[], runtime: CodexTurnRuntime): Promise<void> => {
      const text = inputs
        .map((i) => i.text)
        .join("\n")
        .trim();
      if (!text || closed || runtime.isClosed()) return;
      if (contaminatedReason) {
        runtime.sink.push({ type: "error", error: contaminatedReason });
        return;
      }
      const tid = threadId;
      if (!tid) throw new Error("Codex session has no provider thread id");
      // Inline any attached input images as data-URL items. Fails the turn
      // (never drops an image) so an edit/combine request can't silently run
      // against a subset of its inputs.
      let turnInput: Awaited<ReturnType<typeof buildTurnInput>>;
      try {
        turnInput = await buildTurnInput(
          text,
          inputs.flatMap((i) => i.images ?? []),
        );
      } catch (err) {
        runtime.sink.push({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const turn: ActiveTurn = {
        ownerSessionId: runtime.ownerSessionId,
        sink: runtime.sink,
        imageTraceCtx: runtime.imageTraceCtx,
        imageTracker: runtime.imageTracker,
        romeTools: runtime.romeTools,
        turnId: null,
        initialInputId: inputs[0]?.inputId,
        completed: false,
        requestUsages: [],
        finalText: "",
        startedAt: Date.now(),
        done,
        resolveDone,
        toolStarted: new Set(),
        pending: [],
        failed: false,
        errorMessage: null,
        errorCode: null,
      };
      activeTurn = turn;
      const effort = normalizeEffort(inputs.at(-1)?.reasoningEffort ?? params.reasoningEffort);
      try {
        const started = (await this.appServerManager.requestForThread(tid, Method.turnStart, {
          threadId: tid,
          input: turnInput,
          effort,
          ...(params.outputSchema ? { outputSchema: params.outputSchema } : {}),
          ...(inputs[0]?.inputId ? { clientUserMessageId: inputs[0].inputId } : {}),
        })) as { turn?: { id?: string } } | undefined;
        turn.turnId ??= started?.turn?.id ?? null;
        // turn/start can acknowledge before the native input becomes steerable.
        // Identified chat inputs wait for their user-message confirmation.
        if (runtime === sourceRuntime && !turn.initialInputId) resolveSourceStarted?.();
        await done;
        // Turn finished. Drain deferred image-generation trace work and the
        // filesystem backstop BEFORE the terminal block — the agent session
        // closes the turn sink on the first result/error, so anything pushed
        // after it is dropped.
        await Promise.allSettled(turn.pending);
        try {
          for (const m of await runtime.imageTracker.collectTraceMessages(runtime.imageTraceCtx)) {
            runtime.sink.push(m);
          }
        } catch (err) {
          log.warn("codex generated-image scan failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (runtime.beforeTerminal && turn.turnId) {
          await runtime.beforeTerminal({ threadId: tid, turnId: turn.turnId });
        }
        if (!closed && !runtime.isClosed()) {
          if (turn.errorMessage) {
            runtime.sink.push(
              turn.errorCode
                ? { type: "error", error: turn.errorMessage, code: turn.errorCode }
                : { type: "error", error: turn.errorMessage },
            );
          } else {
            if (runtime === sourceRuntime && turn.turnId) {
              lastCompletedTurnCheckpoint = turn.turnId;
            }
            const accounting = buildOpenAiAccounting({
              usage: toSdkUsage(turn.usage),
              model: modelName,
              agentName: params.agentName,
              appStoreListingId: params.appStoreListingId,
              reportedCostUsd: calculateTurnCostUsd(turn.requestUsages, modelName),
              stopReason: turn.failed ? "error" : "end_turn",
              durationMs: Date.now() - turn.startedAt,
            });
            if (params.outputSchema) {
              try {
                const structuredOutput: unknown = JSON.parse(turn.finalText);
                if (outputValidator && !outputValidator.validate(structuredOutput)) {
                  runtime.sink.push({
                    type: "error",
                    error: `Codex app-server returned structured output that failed validation: ${formatOutputSchemaErrors(outputValidator.validate.errors).join("; ")}`,
                    accounting,
                  });
                } else {
                  runtime.sink.push({
                    type: "result",
                    content: JSON.stringify(structuredOutput),
                    structuredOutput,
                    accounting,
                  });
                }
              } catch (err) {
                runtime.sink.push({
                  type: "error",
                  error: `Codex app-server returned invalid structured output: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                  accounting,
                });
              }
            } else {
              runtime.sink.push({ type: "result", content: turn.finalText, accounting });
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("codex app-server turn failed", { error: message });
        const classification = classifyCodexFailure(err, this.options);
        if (classification.pending) await classification.pending;
        if (!closed && !runtime.isClosed()) {
          runtime.sink.push(
            classification.code
              ? { type: "error", error: message, code: classification.code }
              : { type: "error", error: message },
          );
        }
      } finally {
        if (runtime === sourceRuntime) resolveSourceStarted?.();
        if (turn.turnId) usageByTurnId.delete(turn.turnId);
        activeTurn = null;
      }
    };

    const dispatcher = new TurnDispatcher<ModelUserInput>({
      runOne: async (inputs) => {
        try {
          await turnCoordinator.run(async () => await runOne(inputs, sourceRuntime));
        } finally {
          resolveSourceStarted?.();
        }
      },
    });

    session.sendUserInput = async (input: ModelUserInput) => {
      if (closed || closing) throw new Error("ModelSession is closed");
      if (contaminatedReason) throw new Error(contaminatedReason);
      if (input.text) {
        sourceStarted = new Promise<void>((resolve) => {
          resolveSourceStarted = resolve;
        });
        dispatcher.enqueue(input);
      }
    };

    session.steerUserInput = async (input) => {
      await sourceStarted;
      const turn = activeTurn;
      if (!turn || turn.completed || turn.ownerSessionId !== params.sessionId || !turn.turnId)
        return "deferred";
      if (closed || closing) throw new Error("ModelSession is closed");
      if (input.injectedToolResult) return "deferred";
      if (
        input.reasoningEffort &&
        normalizeEffort(input.reasoningEffort) !== normalizeEffort(params.reasoningEffort)
      )
        return "deferred";
      const nativeInput = await buildTurnInput(input.text, input.images ?? []);
      if (activeTurn !== turn || turn.completed) return "deferred";
      const response = this.appServerManager.requestForThread(threadId!, Method.turnSteer, {
        threadId,
        expectedTurnId: turn.turnId,
        clientUserMessageId: input.inputId,
        input: nativeInput,
      });
      let timeout: ReturnType<typeof setTimeout>;
      const request = Promise.race([
        response,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Steering acknowledgement timed out; delivery is unknown")),
            10_000,
          );
          timeout.unref?.();
        }),
      ]).finally(() => clearTimeout(timeout));
      // A terminal must not overtake a steering RPC's definitive rejection.
      turn.pending.push(
        request.then(
          () => {},
          () => {},
        ),
      );
      try {
        await request;
        return "accepted";
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "AppServerRpcError" &&
          /no active turn|expected.*turn|turn.*mismatch/i.test(error.message)
        )
          return "deferred";
        throw error;
      }
    };

    const interruptOwnerTurn = async (ownerSessionId: string, reason?: string): Promise<void> => {
      if (closed || !threadId || !activeTurn?.turnId) return;
      if (activeTurn.ownerSessionId !== ownerSessionId) return;
      log.info("codex app-server interrupt", { reason, ownerSessionId });
      try {
        await this.appServerManager.requestForThread(threadId, Method.turnInterrupt, {
          threadId,
          turnId: activeTurn.turnId,
        });
      } catch {
        // best-effort; turn/completed (interrupted) still resolves the turn.
      }
    };

    session.fork = async (forkParams: ModelSessionForkParams): Promise<ModelSessionFork> => {
      if (closed || closing) throw new Error("Cannot fork a closed ModelSession");
      // A native thread/fork would copy the contaminated history into the
      // child; a borrowed fork would run on it directly. Refuse both.
      if (contaminatedReason) throw new Error(contaminatedReason);
      const source = session.providerThreadId;
      if (!source)
        throw new Error("Cannot fork Codex session before providerThreadId is available");
      const mode = forkParams.mode ?? "ephemeral";
      let opened = false;
      let forkedId: string | undefined;
      return {
        providerId: this.id,
        sessionId: forkParams.sessionId,
        sourceSessionId: params.sessionId,
        sourceProviderThreadId: source,
        mode,
        get providerThreadId() {
          return forkedId;
        },
        open: async (openParams) => {
          if (opened) throw new Error("ModelSession fork already opened");
          opened = true;

          const compatibility = evaluateBorrowedExactFork({
            forkParams,
            openParams,
            sourceModelName: modelName,
            sourceSystemPrompt: params.systemPrompt,
            sourceWorkingDir: params.workingDir,
          });
          const targetIsCurrentHead =
            forkParams.sourceCheckpoint === undefined ||
            forkParams.sourceCheckpoint === lastCompletedTurnCheckpoint;
          const borrowSourceThread = compatibility.eligible && targetIsCurrentHead;
          log.info("codex fork strategy selected", {
            strategy: borrowSourceThread ? "borrow_source_thread" : "native_thread_fork",
            configurationMode: forkParams.configurationMode,
            targetedCheckpoint: forkParams.sourceCheckpoint !== undefined,
            targetIsCurrentHead,
            sameModel: compatibility.sameModel,
            sameSystemPrompt: compatibility.sameSystemPrompt,
            sameWorkingDir: compatibility.sameWorkingDir,
          });

          if (borrowSourceThread) {
            forkedId = source;
            return await createBorrowedExactForkSession({
              providerId: this.id,
              forkSessionId: forkParams.sessionId,
              sourceThreadId: source,
              openParams,
              runExclusive: async (work) => await turnCoordinator.run(work),
              runTurn: async (input, runtime) => await runOne([input], runtime),
              rollbackTurn: async (threadIdToRollback) => {
                // Rollback is the only thing keeping the borrowed turn out of
                // the source conversation, so its failure cannot be a plain
                // turn error. An error response means the rollback was not
                // applied (stdio JSON-RPC; a response is only lost when the
                // process died, and then the retry rejects locally without
                // re-sending), so one retry cannot double-rollback.
                let lastMessage = "unknown error";
                for (let attempt = 1; attempt <= 2; attempt++) {
                  try {
                    await this.appServerManager.requestForThread(
                      threadIdToRollback,
                      Method.threadRollback,
                      {
                        threadId: threadIdToRollback,
                        numTurns: 1,
                      },
                    );
                    return;
                  } catch (err) {
                    lastMessage = err instanceof Error ? err.message : String(err);
                    log.warn("codex exact-fork rollback failed", { attempt, error: lastMessage });
                  }
                }
                // The fork's turn is now permanently part of the source
                // thread. Poison the session so nothing resumes from the
                // contaminated history, and surface the failure on the source
                // events stream (out-of-turn, like Notify.error).
                contaminatedReason = `codex exact-fork rollback failed, source thread retains the fork turn: ${lastMessage}`;
                if (!closed) sink.push({ type: "error", error: contaminatedReason });
                throw new Error(contaminatedReason);
              },
              interrupt: async (reason) => await interruptOwnerTurn(forkParams.sessionId, reason),
            });
          }

          // A model- or prompt-changing fork cannot safely borrow the source
          // thread. Materialize a native child and rejoin it through its own
          // session binding on the shared app-server. Supplying the final
          // model at fork time avoids a transient default-model switch in the
          // child's rollout.
          //
          // The snapshot goes through the turn lane: a borrowed exact fork may
          // be mid-turn, and a thread/fork issued then would copy its
          // not-yet-rolled-back turn into the child. Contamination is
          // re-checked inside the lane because a queued snapshot would
          // otherwise run immediately after the failed rollback that set it.
          const forkRomeTools = createRomeDynamicTools(openParams);
          const forkThreadConfig = buildThreadConfig(
            openParams,
            stripLegacyReasoningSuffix(openParams.model),
            forkRomeTools,
          );
          const forkRes = await turnCoordinator.run(async () => {
            if (contaminatedReason) throw new Error(contaminatedReason);
            return await this.appServerManager.requestForThread<
              { thread?: { id?: string } } | undefined
            >(source, Method.threadFork, {
              threadId: source,
              ...(forkParams.sourceCheckpoint ? { lastTurnId: forkParams.sourceCheckpoint } : {}),
              ...forkThreadConfig,
              ephemeral: false,
            });
          });
          forkedId = forkRes?.thread?.id;
          if (!forkedId) throw new Error("codex thread/fork did not return a thread id");
          return await this.openSession({
            ...openParams,
            sessionId: forkParams.sessionId,
            isNewSession: false,
            providerThreadId: forkedId,
            fork: {
              sourceSessionId: params.sessionId,
              sourceProviderThreadId: source,
              mode,
              sourceCheckpoint: forkParams.sourceCheckpoint,
            },
          });
        },
      };
    };
    session.interrupt = async (reason?: string) =>
      await interruptOwnerTurn(params.sessionId, reason);
    session.close = async () => {
      if (closed || closing) return;
      closing = true;
      dispatcher.close();
      await dispatcher.waitForIdle();
      await turnCoordinator.waitForIdle();
      closed = true;
      if (threadId) await this.appServerManager.unsubscribe(threadId);
      sink.end();
    };

    return session;
  }
}
