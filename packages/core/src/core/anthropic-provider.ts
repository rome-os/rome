import { AbortError, query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { DEFAULT_REASONING_EFFORT } from "@rome-os/app-runtime";
import type {
  EffortLevel,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKControlGetContextUsageResponse,
  SDKResultMessage,
  SDKResultSuccess,
  SDKUserMessage,
  SDKUserMessageReplay,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentContextUsage, AgentMessage, AgentPlan } from "../types.js";
import type {
  ModelSessionFork,
  ModelProvider,
  ModelSession,
  ModelSessionForkParams,
  ModelSessionParams,
  ModelUserInput,
  ModelReasoningEffort,
} from "./agent-runner.js";
import { buildAgentAccounting } from "./provider-accounting.js";
import { anthropicStop } from "./stop-reason.js";
import { createLogger } from "../logger.js";
import {
  type ModelMetricAttribution,
  modelTokenMetricAttributes,
  modelTurnDurationMetric,
  modelTokensMetric,
} from "../telemetry.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { parseTimeZone } from "../lib/timezone.js";
import {
  buildAnthropicCompatibleProviderEnv,
  CUSTOM_ANTHROPIC_PROVIDER_ID,
  getStoredAnthropicCompatibleCredentials,
} from "../lib/anthropic-compatible-providers.js";
import {
  clearAnthropicAuthRevoked,
  markAnthropicAuthRevoked,
  resolveAnthropicAuthRevokedSourceForQuery,
  type AnthropicAuthRevokedSource,
} from "../lib/anthropic-login.js";
import {
  ANTHROPIC_AUTH_REVOKED_CODE,
  isAnthropicAuthRevokedError,
} from "./anthropic-auth-revoked.js";
import { buildAnthropicMcpServers } from "./anthropic-mcp-servers.js";
import { isAnthropicUsageLimitError } from "./anthropic-usage-limit.js";
import { createClaudeQueryProcess } from "./claude-query-process.js";
import {
  compileOutputSchema,
  formatOutputSchemaErrors,
} from "../apps/packaging/output-schema-validator.js";

// Beta content block types are not re-exported from the agent SDK and
// `@anthropic-ai/sdk` is not a direct dependency, so we derive the shapes
// we need from the message types the agent SDK does expose. This keeps the
// shapes tied to the SDK definitions: if Anthropic changes them, typecheck
// will break here rather than at runtime.
type AssistantContentBlock = SDKAssistantMessage["message"]["content"][number];
type UserMessageContent = (SDKUserMessage | SDKUserMessageReplay)["message"]["content"];
type UserContentBlock = Exclude<UserMessageContent, string>[number];
type BetaUsageShape = SDKResultSuccess["usage"];
type BetaTextBlock = Extract<AssistantContentBlock, { type: "text" }>;
type BetaThinkingBlock = Extract<AssistantContentBlock, { type: "thinking" }>;
type BetaToolUseBlock = Extract<AssistantContentBlock, { type: "tool_use" }>;
type BetaToolResultBlockParam = Extract<UserContentBlock, { type: "tool_result" }>;

const log = createLogger("anthropic-provider");
const GUARDIAN_TIMEZONE_SETTING_KEY = "guardianTimezone";
// IS_SANDBOX silences the SDK's "you're running outside a sandbox" warning.
// We deliberately do NOT pass CLAUDE_CODE_ENABLE_TELEMETRY — the SDK's
// resulting spans land as orphan traces (no TRACEPARENT
// auto-injection from Rome's `model.turn`), which clutters the trace store
// without adding signal. The per-round / per-tool detail is reconstructed
// by `turn-span-translator.ts` from the message stream instead.
// CLAUDE_CODE_ENABLE_TASKS=false keeps TodoWrite, which Rome turns into plan
// updates. Since Claude Code 2.1.251 the default swaps it for TaskCreate.
const CLAUDE_AGENT_SDK_ENV = {
  IS_SANDBOX: "1",
  CLAUDE_CODE_ENABLE_TASKS: "false",
} as const;

function toAnthropicEffort(effort: ModelReasoningEffort | undefined): EffortLevel {
  if (effort === "xhigh") return "max";
  return effort ?? DEFAULT_REASONING_EFFORT;
}

interface AnthropicProviderOptions {
  settingsRepo?: Pick<SettingsRepository, "get">;
  env?: NodeJS.ProcessEnv;
  /** Update runtime auth state before an auth-revoked terminal is exposed. */
  onAuthRevoked?: () => Promise<void> | void;
  /** Mark quota before the usage-limit terminal is exposed to AgentSession. */
  onQuotaExhausted?: () => void;
}

/** Persist the revoked-credential marker before exposing the failed terminal. */
async function persistAnthropicAuthRevoked(
  source: AnthropicAuthRevokedSource | null,
  onAuthRevoked: AnthropicProviderOptions["onAuthRevoked"],
): Promise<void> {
  // Raw environment credentials have no Rome-managed login surface or stable
  // source marker, so keep their 401 as a plain provider error.
  if (!source) return;
  try {
    await markAnthropicAuthRevoked(source);
  } catch (err) {
    log.warn("failed to persist anthropic auth-revoked marker", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await onAuthRevoked?.();
  } catch (err) {
    log.warn("failed to update AI tool state after anthropic auth revocation", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isAssistantMessage(message: SDKMessage): message is SDKAssistantMessage {
  return message.type === "assistant";
}

function isUserMessage(message: SDKMessage): message is SDKUserMessage | SDKUserMessageReplay {
  return message.type === "user";
}

function isResultMessage(message: SDKMessage): message is SDKResultMessage {
  return message.type === "result";
}

function isPartialAssistantMessage(message: SDKMessage): message is SDKPartialAssistantMessage {
  return message.type === "stream_event";
}

function isResultSuccess(result: SDKResultMessage): result is SDKResultSuccess {
  return result.subtype === "success";
}

/** The uuids of the sends a frame or result answers (the SDK's echo). */
function echoedSendIds(message: {
  user_message_uuid?: string;
  user_message_uuids?: string[];
}): string[] {
  return (
    message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : [])
  );
}

/** The uuid of a replayed user message, if `message` is one. */
function replayedSendId(message: SDKMessage): string | undefined {
  return isUserMessage(message) && "isReplay" in message && message.isReplay
    ? message.uuid
    : undefined;
}

// Which side owns the SDK turn after `message`, from the SDK's echo alone. A
// top-level frame echoing one of Rome's sends gives the turn to Rome; that is
// also how a send the SDK folds into its own turn takes it over, since the
// first reply after the fold echoes it. A turn whose first frame echoes none
// of Rome's sends is one the SDK started by itself. Later frames carry no
// echo, so they keep the owner.
function sdkTurnOwnerAfter(
  message: SDKMessage,
  current: "rome" | "sdk" | undefined,
  romeSendIds: ReadonlySet<string>,
): "rome" | "sdk" | undefined {
  const isModelFrame =
    (isAssistantMessage(message) || isPartialAssistantMessage(message)) &&
    message.parent_tool_use_id === null;
  if (!isModelFrame) return current;
  if (echoedSendIds(message).some((id) => romeSendIds.has(id))) return "rome";
  return current ?? "sdk";
}

function isTextBlock(block: AssistantContentBlock): block is BetaTextBlock {
  return block.type === "text";
}

function isThinkingBlock(block: AssistantContentBlock): block is BetaThinkingBlock {
  return block.type === "thinking";
}

function isToolUseBlock(block: AssistantContentBlock): block is BetaToolUseBlock {
  return block.type === "tool_use";
}

function isToolResultParam(block: UserContentBlock): block is BetaToolResultBlockParam {
  return block.type === "tool_result";
}

function buildRawUsage(usage: BetaUsageShape): Record<string, unknown> | undefined {
  // Pricing rules (provider-accounting.ts) read flat scalar fields out of
  // rawUsage; the nested cache_creation object isn't useful and would only
  // bloat the persisted accounting blob.
  const entries = Object.entries(usage).filter(([, value]) => {
    if (value === null) return true;
    if (Array.isArray(value)) return false;
    const valueType = typeof value;
    return valueType === "string" || valueType === "number" || valueType === "boolean";
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function buildContextUsageFromSdk(
  contextUsage: SDKControlGetContextUsageResponse,
): AgentContextUsage | undefined {
  const usedTokens = readPositiveNumber(contextUsage.totalTokens);
  if (usedTokens === undefined) {
    return undefined;
  }

  const windowTokens =
    readPositiveNumber(contextUsage.rawMaxTokens) ?? readPositiveNumber(contextUsage.maxTokens);

  return {
    usedTokens,
    windowTokens,
    remainingTokens:
      windowTokens !== undefined ? Math.max(windowTokens - usedTokens, 0) : undefined,
  };
}

async function readSdkContextUsage(
  q: Pick<Query, "getContextUsage">,
): Promise<AgentContextUsage | undefined> {
  try {
    const contextUsage = await q.getContextUsage();
    return buildContextUsageFromSdk(contextUsage);
  } catch (err) {
    log.warn("failed to read SDK context usage", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Reasoning tokens from the Messages API's `output_tokens_details`. The API
 * computes the count by re-tokenizing the raw reasoning, so it is an
 * estimate that can differ from the billed count by a few tokens.
 */
function readReasoningTokens(usage: BetaUsageShape): number | undefined {
  const details = (usage as { output_tokens_details?: unknown }).output_tokens_details;
  if (!details || typeof details !== "object") return undefined;
  return readPositiveNumber((details as { thinking_tokens?: unknown }).thinking_tokens);
}

function buildAnthropicAccounting(
  result: SDKResultMessage,
  model: string,
  providerId: string,
  context?: AgentContextUsage,
  aborted = false,
) {
  // SDK types mark these required, but mock test data may omit them; treat
  // the absence of `usage` as "no accounting to report" rather than crashing.
  const usage = (result as { usage?: BetaUsageShape }).usage;
  if (!usage) {
    return undefined;
  }

  const reasoningTokens = readReasoningTokens(usage);
  return buildAgentAccounting({
    provider: providerId,
    model,
    usage: {
      inputTokens: readPositiveNumber(usage.input_tokens) ?? 0,
      outputTokens: readPositiveNumber(usage.output_tokens) ?? 0,
      cacheReadTokens: readPositiveNumber(usage.cache_read_input_tokens) ?? 0,
      cacheWriteTokens: readPositiveNumber(usage.cache_creation_input_tokens) ?? 0,
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    },
    reportedCostUsd: readPositiveNumber(result.total_cost_usd),
    numTurns: readPositiveNumber(result.num_turns),
    stop: anthropicStop(result, aborted),
    stopReason: result.stop_reason ?? undefined,
    durationMs: readPositiveNumber(result.duration_ms),
    rawUsage: buildRawUsage(usage),
    context,
  });
}

function normalizeToolName(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const normalized = parts.at(-1);
    if (normalized) {
      return normalized;
    }
  }
  return name;
}

function normalizeTodoWritePlan(input: unknown): AgentPlan | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const rawTodos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(rawTodos)) return null;

  const steps: AgentPlan["steps"] = [];
  for (const candidate of rawTodos) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const todo = candidate as {
      content?: unknown;
      activeForm?: unknown;
      status?: unknown;
    };
    const text = typeof todo.content === "string" ? todo.content.trim() : "";
    if (!text) continue;
    if (todo.status !== "pending" && todo.status !== "in_progress" && todo.status !== "completed") {
      continue;
    }
    const activeText = typeof todo.activeForm === "string" ? todo.activeForm.trim() : undefined;
    steps.push({
      text,
      ...(activeText ? { activeText } : {}),
      status: todo.status,
    });
  }

  // An explicit empty array clears the Plan. Malformed non-empty input keeps
  // the last valid snapshot intact by producing no update.
  if (rawTodos.length > 0 && steps.length === 0) return null;
  return { steps };
}

function extractToolResultMessages(
  message: SDKUserMessage | SDKUserMessageReplay,
  toolUseNames: Map<string, string>,
): AgentMessage[] {
  const payload = message.message;
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const contentResults = content.filter(isToolResultParam).map((block): AgentMessage => {
    const output =
      typeof block.is_error === "boolean"
        ? { content: block.content, isError: block.is_error }
        : block.content;
    return {
      type: "tool_result",
      toolUseId: block.tool_use_id,
      tool: normalizeToolName(toolUseNames.get(block.tool_use_id) ?? "unknown"),
      output,
      endedAt: new Date().toISOString(),
      // The Messages API marks a failed tool result with `is_error`; its
      // absence means success.
      isError: block.is_error === true,
    };
  });
  if (contentResults.length > 0) {
    return contentResults;
  }

  const parentToolUseId = message.parent_tool_use_id;
  if (parentToolUseId && "tool_use_result" in message) {
    // `tool_use_result` has no documented failure signal, so this result
    // leaves `isError` unset ("the producer cannot tell").
    return [
      {
        type: "tool_result",
        toolUseId: parentToolUseId,
        tool: normalizeToolName(toolUseNames.get(parentToolUseId) ?? "unknown"),
        output: message.tool_use_result,
        endedAt: new Date().toISOString(),
      },
    ];
  }

  return [];
}

function recordModelCallMetrics(
  model: string,
  accounting: ReturnType<typeof buildAnthropicAccounting>,
  result: SDKResultMessage,
  attribution: ModelMetricAttribution,
): void {
  const durationMs = readPositiveNumber(result.duration_ms);
  if (typeof durationMs === "number") {
    modelTurnDurationMetric().record(durationMs, { model });
  }

  const usage = accounting?.usage;
  if (!usage) {
    return;
  }

  const tokens = modelTokensMetric();
  // Treat cache reads/writes as input-side tokens — they're billed on the input path
  // and what operators want to see in the "in" series is total input work sent.
  const inTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (inTokens > 0) {
    tokens.add(inTokens, modelTokenMetricAttributes(model, "in", attribution));
  }
  if (usage.outputTokens > 0) {
    tokens.add(usage.outputTokens, modelTokenMetricAttributes(model, "out", attribution));
  }
}

async function getStoredTimezone(
  settingsRepo?: Pick<SettingsRepository, "get">,
): Promise<string | null> {
  if (!settingsRepo) {
    return null;
  }

  return parseTimeZone(await settingsRepo.get(GUARDIAN_TIMEZONE_SETTING_KEY));
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic" as const;
  readonly displayName = "Claude";
  readonly builtinTools: ReadonlySet<string> = new Set([
    "Read",
    "Edit",
    "Write",
    "Bash",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "TodoWrite",
    "Task",
  ]);

  constructor(private options: AnthropicProviderOptions = {}) {}

  private async buildQueryContext(): Promise<{
    env: Record<string, string | undefined>;
    authRevokedSource: AnthropicAuthRevokedSource | null;
  }> {
    const [credentials, timezone] = await Promise.all([
      getStoredAnthropicCompatibleCredentials(this.options.settingsRepo),
      getStoredTimezone(this.options.settingsRepo),
    ]);
    const baseEnv = this.options.env ?? process.env;
    const compatibleProviderEnv = credentials
      ? buildAnthropicCompatibleProviderEnv(credentials)
      : undefined;

    // A custom environment is a complete provider configuration. Do not let
    // inherited Anthropic / Claude Code variables silently alter it.
    const inheritedEnv = { ...baseEnv };
    if (credentials?.provider === CUSTOM_ANTHROPIC_PROVIDER_ID) {
      for (const key of Object.keys(inheritedEnv)) {
        if (
          key.startsWith("ANTHROPIC_") ||
          key.startsWith("CLAUDE_CODE_") ||
          key === "API_TIMEOUT_MS" ||
          key === "ENABLE_TOOL_SEARCH"
        ) {
          delete inheritedEnv[key];
        }
      }
    }

    const env: Record<string, string | undefined> = {
      ...inheritedEnv,
      ...(compatibleProviderEnv ?? {}),
      ...(timezone ? { TZ: timezone } : {}),
      ...CLAUDE_AGENT_SDK_ENV,
    };
    if (compatibleProviderEnv) {
      if (!("ANTHROPIC_API_KEY" in compatibleProviderEnv)) {
        delete env.ANTHROPIC_API_KEY;
      }
      if (!("ANTHROPIC_AUTH_TOKEN" in compatibleProviderEnv)) {
        delete env.ANTHROPIC_AUTH_TOKEN;
      }
    }

    return {
      env,
      authRevokedSource: await resolveAnthropicAuthRevokedSourceForQuery(credentials, baseEnv),
    };
  }

  // Long-lived streaming-input session
  //
  // openSession() opens one CLI subprocess per conversation. The host pushes
  // turns onto an in-memory queue via sendUserInput(); a single events loop
  // translates SDK messages → AgentMessages for the lifetime of the query.
  // close() ends the queue and closes the SDK Query, which lets the SDK shut
  // its CLI subprocess down cleanly.

  async openSession(params: ModelSessionParams): Promise<ModelSession> {
    const {
      model,
      systemPrompt,
      subagentTools,
      handback,
      maxTurns = 500,
      executeAction,
      executeSubagent,
      executeSubmitOutput,
      executeDefer,
    } = params;
    const outputValidator = params.outputSchema
      ? compileOutputSchema(params.outputSchema)
      : undefined;

    const toolUseNames = new Map<string, string>();

    const mcpServers = buildAnthropicMcpServers({
      getActionCatalog: params.getActionCatalog,
      getSkillCatalog: params.getSkillCatalog,
      subagentTools,
      handback,
      externalMcpServers: params.externalMcpServers,
      executeAction,
      executeSubagent,
      executeSubmitOutput,
      supportsInteractiveSurface: params.supportsInteractiveSurface,
      interactiveSurfaceDetached: params.interactiveSurfaceDetached,
      executeDefer,
    });

    const queryContext = await this.buildQueryContext();
    const effort = toAnthropicEffort(params.reasoningEffort);
    const queryEnv: Record<string, string | undefined> = {
      ...queryContext.env,
      CLAUDE_CODE_EFFORT_LEVEL: effort,
    };
    const effectiveModel = queryEnv.ANTHROPIC_MODEL ?? model;
    const authRevokedSource = queryContext.authRevokedSource;
    const providerId = this.id;
    const openProviderSession = this.openSession.bind(this);
    // Captured for the events generator below (a plain `async function*` with no
    // `this`): update runtime state before classified terminals become observable.
    const onAuthRevoked = this.options.onAuthRevoked;
    const onQuotaExhausted = this.options.onQuotaExhausted;

    const inputQueue = new AsyncMessageQueue<SDKUserMessage>();
    const queryProcess = createClaudeQueryProcess();
    const { abortController } = queryProcess;
    const { sessionId } = params;
    const pendingSteers = new Set<string>();
    const deferredInputs = new Set<string>();
    // Every send carries a uuid and origin {kind:"human"}. The SDK echoes a
    // send's uuid on the turn that answers it, and a turn it starts by itself
    // (a finished background task) echoes none. That echo decides which Rome
    // turn owns the SDK's output.
    const romeSendIds = new Set<string>();
    // Uuids minted for sends without an inputId. Rome issued no id for them,
    // so their replay reports no input status.
    const mintedSendIds = new Set<string>();
    // Owner of the SDK turn now streaming; undefined between a result and the
    // next turn's first frame.
    let sdkTurnOwner: "rome" | "sdk" | undefined;
    // Output for one of Rome's sends can arrive with no Rome turn open, e.g. a
    // steer the SDK carried past the previous turn's result. Reading pauses
    // until Rome opens the next turn, so the output has a turn to go to. The
    // pause ends because the provider reported that send as queued, and
    // Rome's next turn adopts a queued input before anything else; interrupt
    // and close also end it.
    // The send that opened the current Rome turn.
    let turnSendId: string | undefined;
    let resumeReading: (() => void) | undefined;
    const openRomeTurn = () => {
      resumeReading?.();
      resumeReading = undefined;
    };
    // A cancelled first turn can leave a user-only transcript that is not
    // resumable. Its id is still reserved by the CLI, so don't reuse it.
    const sdkSessionId =
      params.isNewSession === false && !params.providerThreadId ? randomUUID() : sessionId;

    const q = query({
      prompt: inputQueue.iter(),
      options: {
        abortController,
        spawnClaudeCodeProcess: queryProcess.spawn,
        model: effectiveModel,
        effort,
        systemPrompt,
        ...(params.outputSchema
          ? { outputFormat: { type: "json_schema" as const, schema: params.outputSchema } }
          : {}),
        env: queryEnv,
        maxTurns,
        tools: params.builtinTools ?? [],
        mcpServers,
        // Only the servers above. Without this, a claude.ai subscription login
        // also loads that account's claude.ai connectors (Gmail, Drive, ...).
        strictMcpConfig: true,
        debug: true,
        // Surface raw API stream events so the events loop below can yield
        // `text_delta` events while a text block is still being generated.
        includePartialMessages: true,
        extraArgs: { "replay-user-messages": null },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["project"],
        ...(params.workingDir ? { cwd: params.workingDir } : {}),
        ...(params.fork
          ? {
              resume: params.fork.sourceProviderThreadId ?? params.fork.sourceSessionId,
              forkSession: true,
              sessionId,
              ...(params.fork.sourceCheckpoint
                ? { resumeSessionAt: params.fork.sourceCheckpoint }
                : {}),
            }
          : // Resume only once a real turn has actually written a transcript for
            // this id. `providerThreadId` is captured from the SDK's own
            // `session_id` (below) and persisted after the first turn that
            // produced content; absent it, a stored session row may have come
            // from a short-circuited turn (e.g. the not-logged-in notice) that
            // never opened an SDK conversation, and `{ resume }` would fail with
            // "No conversation found with session ID". Start fresh in that case.
            !params.isNewSession && params.providerThreadId
            ? { resume: params.providerThreadId }
            : { sessionId: sdkSessionId }),
      },
    });

    // `closed` means the public event/input surface can no longer be used. It
    // is set when the events iterator ends, including when a fork consumer
    // returns immediately after its terminal block. That does *not* prove the
    // SDK Query was disposed: iterator return can happen while the long-lived
    // query process is still waiting on the input queue. Track disposal
    // separately so ModelSession.close() always reaches inputQueue.end() and
    // q.close() exactly once.
    let closed = false;
    let queryDisposed = false;
    let running = false;

    // The SDK's own session id, captured from the first assistant message once a
    // transcript with real content exists. Exposed via `session.providerThreadId`
    // so the host persists it and gates `{ resume }` on it (see options above).
    let establishedThreadId: string | undefined =
      params.isNewSession === false ? params.providerThreadId : undefined;
    let activeTurnLastAssistantMessageId: string | undefined;
    let lastCompletedTurnCheckpoint: string | undefined;

    // Translate the SDK's lifetime stream into AgentMessages. Runs once for
    // the whole session; turn boundaries live one layer up (AgentSession §6).
    const events: AsyncIterable<AgentMessage> = (async function* () {
      // In-turn narration vs. closing answer. The agent SDK never sets
      // `stop_reason` on its streamed assistant messages (always null) and splits
      // a single API message into one `assistant` message per content block, so
      // there is no per-message field that tells us, at arrival, whether a text
      // block is mid-turn commentary or the final answer. We resolve it by
      // position with a one-step lookahead: hold each completed text block; the
      // moment any further turn activity (more text, a thinking block, or a tool
      // call) arrives, the held block is confirmed mid-turn → tag it `commentary`.
      // Whatever text is still held when the terminal `result`/`error` lands is
      // the closing answer → tag it `final`. Live `text_delta` events still
      // stream in real time; only the completed-block event is deferred by one
      // step (a block isn't truly "done" until the next one starts anyway).
      let pendingText: string | null = null;
      let pendingTextBlockId: string | undefined;
      let partialText = "";
      let partialTextBlockId: string | undefined;
      // Block identity is `<API message id>:<content block index>`. The stream
      // reports the index on each `content_block_*` event; the SDK then sends
      // each completed block as its own assistant message, in index order, so
      // counting blocks per message id yields the same index.
      let streamMessageId: string | undefined;
      const streamToolBlocks = new Map<number, { id: string; name: string }>();
      const assistantBlockCounts = new Map<string, number>();
      const blockIdOf = (messageId: string | undefined, index: number): string | undefined =>
        messageId ? `${messageId}:${index}` : undefined;
      const textBlock = (
        content: string,
        turnPhase: "commentary" | "final",
        blockId: string | undefined,
      ): AgentMessage =>
        blockId
          ? { type: "text", content, turnPhase, blockId }
          : { type: "text", content, turnPhase };
      try {
        for await (const message of q) {
          const replayedId = replayedSendId(message);
          const romeReplay = replayedId !== undefined && romeSendIds.has(replayedId);
          const owner = sdkTurnOwnerAfter(message, sdkTurnOwner, romeSendIds);
          const romeClaims = romeReplay || (owner === "rome" && sdkTurnOwner !== "rome");
          sdkTurnOwner = owner;
          if (romeClaims && !running && !closed) {
            const inputId =
              replayedId ??
              (isAssistantMessage(message) || isPartialAssistantMessage(message)
                ? echoedSendIds(message).find((id) => romeSendIds.has(id))
                : undefined);
            log.info("pausing SDK stream until Rome opens a turn for a queued send", { inputId });
            await new Promise<void>((resolve) => {
              resumeReading = resolve;
            });
            log.info("resumed SDK stream", { inputId });
          }
          // First assistant message means the SDK has written user+assistant
          // turns to the transcript: record the SDK's own session id so the
          // host can persist it and safely `{ resume }` next time. Capturing
          // here (not at the `system`/init event) is deliberate — an init-only
          // transcript with zero messages also fails to resume. A turn the SDK
          // started by itself writes the transcript too.
          if (establishedThreadId === undefined && isAssistantMessage(message)) {
            establishedThreadId = message.session_id;
          }
          // A turn the SDK started by itself reaches no Rome turn. Replays of
          // Rome's own sends still report their input status.
          const turnFrame =
            isPartialAssistantMessage(message) ||
            isAssistantMessage(message) ||
            isUserMessage(message);
          if (sdkTurnOwner === "sdk" && turnFrame && !romeReplay) continue;
          if (isPartialAssistantMessage(message)) {
            // Deltas of in-flight blocks. Each complete block still arrives
            // on its own assistant message, so this is purely additive for
            // consumers that render live output. Skip
            // SDK-internal subagent streams (parent_tool_use_id set) — Rome's
            // own subagents run in their own provider sessions.
            if (message.parent_tool_use_id === null) {
              const evt = message.event;
              if (evt.type === "message_start") {
                streamMessageId = evt.message.id;
                streamToolBlocks.clear();
              } else if (
                evt.type === "content_block_start" &&
                evt.content_block.type === "tool_use"
              ) {
                streamToolBlocks.set(evt.index, {
                  id: evt.content_block.id,
                  name: normalizeToolName(evt.content_block.name),
                });
              } else if (evt.type === "content_block_delta") {
                const blockId = blockIdOf(streamMessageId, evt.index);
                if (evt.delta.type === "text_delta") {
                  if (params.outputSchema) continue;
                  if (partialText === "" && pendingText !== null) {
                    yield textBlock(pendingText, "commentary", pendingTextBlockId);
                    pendingText = null;
                  }
                  partialText += evt.delta.text;
                  partialTextBlockId = blockId;
                  yield blockId
                    ? { type: "text_delta", content: evt.delta.text, blockId }
                    : { type: "text_delta", content: evt.delta.text };
                } else if (evt.delta.type === "thinking_delta" && evt.delta.thinking && blockId) {
                  // A following block confirms the held text was narration.
                  if (pendingText !== null) {
                    yield textBlock(pendingText, "commentary", pendingTextBlockId);
                    pendingText = null;
                  }
                  yield { type: "thinking_delta", blockId, content: evt.delta.thinking };
                } else if (evt.delta.type === "input_json_delta" && evt.delta.partial_json) {
                  const toolBlock = streamToolBlocks.get(evt.index);
                  if (toolBlock) {
                    if (pendingText !== null) {
                      yield textBlock(pendingText, "commentary", pendingTextBlockId);
                      pendingText = null;
                    }
                    yield {
                      type: "tool_input_delta",
                      toolUseId: toolBlock.id,
                      tool: toolBlock.name,
                      content: evt.delta.partial_json,
                    };
                  }
                }
              }
            }
          } else if (isAssistantMessage(message)) {
            if (message.parent_tool_use_id === null) {
              activeTurnLastAssistantMessageId = message.uuid;
            }
            const apiMessageId = (message.message as { id?: unknown }).id;
            const assistantMessageId = typeof apiMessageId === "string" ? apiMessageId : undefined;
            for (const block of message.message.content) {
              let blockId: string | undefined;
              if (assistantMessageId) {
                const index = assistantBlockCounts.get(assistantMessageId) ?? 0;
                assistantBlockCounts.set(assistantMessageId, index + 1);
                blockId = blockIdOf(assistantMessageId, index);
              }
              if (isTextBlock(block) && block.text) {
                if (params.outputSchema) continue;
                partialText = "";
                partialTextBlockId = undefined;
                // A new text block: the previously held one is now confirmed
                // mid-turn narration. Hold this one until something follows it.
                if (pendingText !== null) {
                  yield textBlock(pendingText, "commentary", pendingTextBlockId);
                }
                pendingText = block.text;
                pendingTextBlockId = blockId;
              } else if (isThinkingBlock(block) && block.thinking) {
                if (pendingText !== null) {
                  yield textBlock(pendingText, "commentary", pendingTextBlockId);
                  pendingText = null;
                }
                yield blockId
                  ? { type: "thinking", content: block.thinking, blockId }
                  : { type: "thinking", content: block.thinking };
              } else if (isToolUseBlock(block)) {
                // A tool call follows the held text → that text was narration.
                if (pendingText !== null) {
                  yield textBlock(pendingText, "commentary", pendingTextBlockId);
                  pendingText = null;
                }
                const normalizedToolName = normalizeToolName(block.name);
                log.debug("tool_use requested", { tool: normalizedToolName });
                if (normalizedToolName === "TodoWrite" && message.parent_tool_use_id === null) {
                  const plan = normalizeTodoWritePlan(block.input);
                  if (plan) {
                    yield { type: "plan_update", plan };
                  } else {
                    log.warn("skipping malformed anthropic TodoWrite plan update", {
                      sessionId: message.session_id,
                      toolUseId: block.id,
                    });
                  }
                }
                toolUseNames.set(block.id, normalizedToolName);
                yield {
                  type: "tool_use",
                  id: block.id,
                  tool: normalizedToolName,
                  input: block.input,
                  startedAt: new Date().toISOString(),
                };
              }
            }
          } else if (isUserMessage(message)) {
            if (romeReplay && replayedId && !mintedSendIds.has(replayedId)) {
              pendingSteers.delete(replayedId);
              yield { type: "input_status", inputId: replayedId, state: "consumed" };
            }
            for (const toolResult of extractToolResultMessages(message, toolUseNames)) {
              yield toolResult;
            }
          } else if (isResultMessage(message)) {
            // Block ids are unique within a turn; start the next turn's count fresh.
            assistantBlockCounts.clear();
            const echoed = echoedSendIds(message).filter((id) => romeSendIds.has(id));
            const ownerAtResult = sdkTurnOwner;
            sdkTurnOwner = undefined;
            // A result follows the owner its frames were routed to. A turn with
            // no frames (the empty results of a resumed or batched background
            // task) is the SDK's own when its origin says so. Such a result ends
            // no Rome turn, but it runs the same accounting, metrics and account
            // handling as any other: it may have called the model.
            const sdkOwned =
              echoed.length === 0 &&
              ownerAtResult !== "rome" &&
              (ownerAtResult === "sdk" || message.origin?.kind === "task-notification");
            if (!sdkOwned) {
              running = false;
              // The SDK owns these queued messages already. Rebind them to a
              // new Rome turn before reading on into the turn that answers them.
              for (const inputId of pendingSteers) {
                deferredInputs.add(inputId);
                yield { type: "input_status", inputId, state: "queued" };
              }
              pendingSteers.clear();
              // Forget the sends this result answered. A send it didn't answer
              // may still get a reply, which must reach a Rome turn. A result
              // that answers none (a frameless SDK error) takes the place of
              // this turn's own reply, so that send is forgotten instead.
              const answered = echoed.length > 0 ? echoed : turnSendId ? [turnSendId] : [];
              for (const id of answered) {
                if (deferredInputs.has(id)) continue;
                romeSendIds.delete(id);
                mintedSendIds.delete(id);
              }
              // The turn is ending: any text still held was the closing answer.
              if (!params.outputSchema && pendingText !== null) {
                yield textBlock(pendingText, "final", pendingTextBlockId);
                pendingText = null;
              }
            }
            if (abortController.signal.aborted) await queryProcess.abort();
            const contextUsage = abortController.signal.aborted
              ? undefined
              : await readSdkContextUsage(q);
            const accounting = buildAnthropicAccounting(
              message,
              effectiveModel,
              providerId,
              contextUsage,
              abortController.signal.aborted,
            );
            const resultData = {
              subtype: message.subtype,
              numTurns: message.num_turns,
              stopReason: message.stop_reason,
              costUsd: accounting?.costUsd,
              durationMs: message.duration_ms,
              ...(sdkOwned ? { sdkInitiated: true } : {}),
            };

            let terminal: AgentMessage;
            if (isResultSuccess(message)) {
              log.info("agent SDK result", resultData);
              recordModelCallMetrics(effectiveModel, accounting, message, {
                agentName: params.agentName,
                appStoreListingId: params.appStoreListingId,
              });
              // A turn that reached the API proves the credential works; drop any
              // lingering revoked marker (covers a Keychain re-login whose file
              // fingerprint we can't diff).
              void clearAnthropicAuthRevoked(authRevokedSource).catch(() => {});
              if (!sdkOwned) lastCompletedTurnCheckpoint = activeTurnLastAssistantMessageId;
              if (params.outputSchema) {
                if (!("structured_output" in message) || message.structured_output === undefined) {
                  terminal = {
                    type: "error",
                    error: "Claude Agent SDK completed without structured output",
                    accounting,
                  };
                } else {
                  const structuredOutput = message.structured_output;
                  if (outputValidator && !outputValidator.validate(structuredOutput)) {
                    terminal = {
                      type: "error",
                      error: `Claude Agent SDK returned structured output that failed validation: ${formatOutputSchemaErrors(outputValidator.validate.errors).join("; ")}`,
                      accounting,
                    };
                  } else {
                    terminal = {
                      type: "result",
                      content: JSON.stringify(structuredOutput),
                      structuredOutput,
                      accounting,
                    };
                  }
                }
              } else {
                terminal = {
                  type: "result",
                  content: message.result || "",
                  accounting,
                };
              }
            } else {
              const errors = message.errors ?? [];
              log.error("agent SDK result", { ...resultData, errors });
              const errorText = errors.join("; ") || `Agent run failed (${message.subtype})`;
              // A 401 here means the credential `claude auth status` reports as
              // valid was rejected server-side. Stamp `auth_revoked` and persist
              // the marker so the next state refresh can downgrade the badge.
              if (isAnthropicUsageLimitError(errors) || isAnthropicUsageLimitError(errorText)) {
                onQuotaExhausted?.();
                terminal = { type: "error", error: errorText, code: "usage_limit", accounting };
              } else if (
                isAnthropicAuthRevokedError(errors) ||
                isAnthropicAuthRevokedError(errorText)
              ) {
                await persistAnthropicAuthRevoked(authRevokedSource, onAuthRevoked);
                terminal = {
                  type: "error",
                  error: errorText,
                  ...(authRevokedSource ? { code: ANTHROPIC_AUTH_REVOKED_CODE } : {}),
                  accounting,
                };
              } else if (message.terminal_reason === "prompt_too_long") {
                terminal = {
                  type: "error",
                  error: errorText,
                  code: "context_window_exceeded",
                  accounting,
                };
              } else {
                terminal = { type: "error", error: errorText, accounting };
              }
            }
            if (!sdkOwned) yield terminal;
          }
        }
        if (abortController.signal.aborted && running) {
          await queryProcess.abort();
          if (!params.outputSchema && pendingText !== null) {
            yield textBlock(pendingText, partialText ? "commentary" : "final", pendingTextBlockId);
          }
          if (!params.outputSchema && partialText)
            yield textBlock(partialText, "final", partialTextBlockId);
          running = false;
          yield params.outputSchema
            ? { type: "error", error: "Claude structured-output turn was interrupted" }
            : { type: "result", content: partialText || pendingText || "" };
        }
      } catch (err) {
        // The stream threw without delivering a terminal `result` (raw abort,
        // SDK panic, …). Flush any held text as the closing answer before the
        // error propagates, so a completed block the consumer already previewed
        // isn't silently dropped. Done in `catch` rather than `finally` on
        // purpose: a `yield` in `finally` re-suspends the generator when the
        // consumer abandons iteration via `.return()`, swallowing the close.
        if (!params.outputSchema && pendingText !== null) {
          yield textBlock(pendingText, partialText ? "commentary" : "final", pendingTextBlockId);
        }
        if (!params.outputSchema && partialText)
          yield textBlock(partialText, "final", partialTextBlockId);
        if (abortController.signal.aborted && err instanceof AbortError) {
          await queryProcess.abort();
          if (running) {
            running = false;
            yield params.outputSchema
              ? { type: "error", error: "Claude structured-output turn was interrupted" }
              : { type: "result", content: partialText || pendingText || "" };
          }
          return;
        }
        // A 401 can also surface as a thrown stream error rather than a result
        // with `subtype: error`. Convert it to a classified terminal and persist
        // the marker instead of rethrowing a raw 401 up the events loop.
        if (isAnthropicUsageLimitError(err)) {
          running = false;
          onQuotaExhausted?.();
          yield {
            type: "error",
            error: err instanceof Error ? err.message : String(err),
            code: "usage_limit",
          };
          return;
        }
        if (isAnthropicAuthRevokedError(err)) {
          running = false;
          await persistAnthropicAuthRevoked(authRevokedSource, onAuthRevoked);
          yield {
            type: "error",
            error: err instanceof Error ? err.message : String(err),
            ...(authRevokedSource ? { code: ANTHROPIC_AUTH_REVOKED_CODE } : {}),
          };
          return;
        }
        throw err;
      } finally {
        closed = true;
      }
    })();

    const session: ModelSession = {
      providerId,
      model: effectiveModel,
      // Claude fixes effort at open and ignores a per-turn effort.
      appliedReasoningEffort: effort,
      get isClosed(): boolean {
        return closed || abortController.signal.aborted;
      },
      get providerThreadId(): string | undefined {
        return establishedThreadId;
      },
      get lastCompletedTurnCheckpoint(): string | undefined {
        return lastCompletedTurnCheckpoint;
      },
      events,
      async sendUserInput(input: ModelUserInput): Promise<void> {
        if (closed || abortController.signal.aborted) {
          throw new Error("ModelSession is closed");
        }
        activeTurnLastAssistantMessageId = undefined;
        // A checkpoint is publishable only after this turn reaches an SDK
        // success result. Assistant UUIDs observed before an abort can be
        // present in the stream without being resumable in Claude's durable
        // transcript, so never let a prior or partial UUID stand in for the
        // current turn.
        lastCompletedTurnCheckpoint = undefined;
        running = true;
        openRomeTurn();
        if (input.inputId && deferredInputs.delete(input.inputId)) {
          turnSendId = input.inputId;
          return;
        }
        const content: NonNullable<SDKUserMessage["message"]["content"]> = [];
        if (input.injectedToolResult) {
          content.push({
            type: "tool_result",
            tool_use_id: input.injectedToolResult.toolUseId,
            content: serializeInjectedToolContent(input.injectedToolResult.content),
          });
        }
        if (input.text) {
          content.push({ type: "text", text: input.text });
        }
        if (content.length > 0) {
          activeTurnLastAssistantMessageId = undefined;
          running = true;
        }
        const uuid = input.inputId ?? randomUUID();
        turnSendId = uuid;
        romeSendIds.add(uuid);
        if (!input.inputId) mintedSendIds.add(uuid);
        const sdkMsg: SDKUserMessage = {
          type: "user",
          uuid: uuid as SDKUserMessage["uuid"],
          origin: { kind: "human" },
          priority: "next",
          parent_tool_use_id: null,
          session_id: sdkSessionId,
          message: {
            role: "user",
            content,
          },
        };
        inputQueue.push(sdkMsg);
      },
      async steerUserInput(input: ModelUserInput): Promise<"accepted" | "deferred"> {
        if (closed || abortController.signal.aborted) {
          throw new Error("ModelSession is closed");
        }
        if (!running || !input.inputId || input.injectedToolResult) return "deferred";
        if (input.reasoningEffort && toAnthropicEffort(input.reasoningEffort) !== effort)
          return "deferred";
        pendingSteers.add(input.inputId);
        romeSendIds.add(input.inputId);
        inputQueue.push({
          type: "user",
          uuid: input.inputId as SDKUserMessage["uuid"],
          origin: { kind: "human" },
          priority: "next",
          parent_tool_use_id: null,
          session_id: sdkSessionId,
          message: { role: "user", content: [{ type: "text", text: input.text }] },
        });
        return "accepted";
      },
      async fork(forkParams: ModelSessionForkParams): Promise<ModelSessionFork> {
        if (closed || abortController.signal.aborted) {
          throw new Error("Cannot fork a closed ModelSession");
        }
        if (running) throw new Error("Cannot fork while source session is running");
        const mode = forkParams.mode ?? "ephemeral";
        const sourceSessionId = params.sessionId;
        const sourceProviderThreadId = establishedThreadId ?? params.providerThreadId;
        const forkSessionId = forkParams.sessionId;
        let opened = false;

        return {
          providerId,
          sessionId: forkSessionId,
          sourceSessionId,
          sourceProviderThreadId,
          mode,
          providerThreadId: forkSessionId,
          open: async (openParams) => {
            if (opened) {
              throw new Error("ModelSession fork already opened");
            }
            opened = true;
            return await openProviderSession({
              ...openParams,
              sessionId: forkSessionId,
              isNewSession: false,
              providerThreadId: forkSessionId,
              fork: {
                sourceSessionId,
                sourceProviderThreadId,
                mode,
                sourceCheckpoint: forkParams.sourceCheckpoint,
              },
            });
          },
        };
      },
      async interrupt(reason?: string): Promise<void> {
        log.info("ModelSession interrupt requested", { reason });
        openRomeTurn();
        await queryProcess.abort();
        inputQueue.end();
      },
      async close(): Promise<void> {
        if (queryDisposed) return;
        queryDisposed = true;
        openRomeTurn();
        try {
          inputQueue.end();
        } catch {
          // ignore
        }
        try {
          q.close?.();
        } catch {
          // ignore
        }
        closed = true;
      },
    };

    return session;
  }
}

// AsyncMessageQueue — promise-based queue used as the streaming-input
// AsyncIterable for the SDK's `query({ prompt: queue.iter() })`.

class AsyncMessageQueue<T> {
  private values: T[] = [];
  private resolvers: Array<(item: IteratorResult<T>) => void> = [];
  private done = false;

  push(value: T): void {
    if (this.done) {
      throw new Error("AsyncMessageQueue is closed");
    }
    if (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!;
      r({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!;
      r({ value: undefined as unknown as T, done: true });
    }
  }

  iter(): AsyncIterable<T> {
    const next = async (): Promise<IteratorResult<T>> => {
      if (this.values.length > 0) {
        const value = this.values.shift()!;
        return { value, done: false };
      }
      if (this.done) {
        return { value: undefined as unknown as T, done: true };
      }
      return await new Promise<IteratorResult<T>>((resolve) => {
        this.resolvers.push(resolve);
      });
    };
    return {
      [Symbol.asyncIterator]() {
        return { next };
      },
    };
  }
}

function serializeInjectedToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
