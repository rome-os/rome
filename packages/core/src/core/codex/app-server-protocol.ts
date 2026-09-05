// Minimal vendored subset of the codex app-server JSON-RPC protocol.
//
// These shapes are transcribed from the authoritative TypeScript bindings the
// installed codex binary emits via `codex app-server generate-ts` (v2 surface,
// codex-cli 0.153.4). We vendor only what the CodexAppServerProvider consumes
// rather than depend on a generated package — the binary has no published TS
// SDK for app-server. Keep field names exact: they are the wire contract.
//
// `agentMessage` items carry `phase` (commentary | final_answer | null), and
// the server streams `item/agentMessage/delta`. See
// KEEP-INTURN-TEXT-RESEARCH.md §3/§7.

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

/** `null` is "phase unknown" — emitted by legacy models that predate the
 *  commentary/final split. Newer codex models populate it. */
export type MessagePhase = "commentary" | "final_answer";

export interface AgentMessageItem {
  type: "agentMessage";
  id: string;
  text: string;
  phase: MessagePhase | null;
  memoryCitation?: unknown;
}

export interface ReasoningItem {
  type: "reasoning";
  id: string;
  summary: string[];
  content: string[];
}

/** Tool-ish items (commandExecution, fileChange, mcpToolCall, webSearch, …).
 *  Typed permissively — the provider reads a handful of fields and otherwise
 *  forwards the raw payload into the tool_use/tool_result trace. */
export interface GenericThreadItem {
  type: string;
  id: string;
  [k: string]: unknown;
}

export type ThreadItem = AgentMessageItem | ReasoningItem | GenericThreadItem;

export function isAgentMessageItem(item: ThreadItem): item is AgentMessageItem {
  return item.type === "agentMessage";
}
export function isReasoningItem(item: ThreadItem): item is ReasoningItem {
  return item.type === "reasoning";
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface ThreadStartedNotification {
  thread: { id: string; sessionId?: string; [k: string]: unknown };
}
export interface ItemStartedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
  startedAtMs: number;
}
export interface ItemCompletedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
  completedAtMs: number;
}
export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}
export interface TurnStartedNotification {
  threadId: string;
  turn: { id: string; [k: string]: unknown };
}
export interface TurnPlanUpdatedNotification {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}
/**
 * Structured failure payload on a failed turn (v2 `TurnError`, camelCase).
 * `codexErrorInfo` is the externally-tagged `CodexErrorInfo` enum — a string
 * for unit variants (e.g. `"usageLimitExceeded"`) or an object for struct
 * variants (e.g. `{ httpConnectionFailed: { httpStatusCode } }`).
 */
export interface TurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
  [k: string]: unknown;
}
export interface TurnCompletedNotification {
  threadId: string;
  // `turn.error` is only populated when `turn.status === "failed"`; it is a
  // `TurnError` object (NOT a string).
  turn: { id: string; status?: string; error?: TurnError; [k: string]: unknown };
}
export interface ThreadTokenUsageUpdatedNotification {
  threadId: string;
  turnId?: string;
  tokenUsage?: ThreadTokenUsage;
  /** Compatibility for early local stubs that used Rome's pre-generated shape. */
  usage?: ThreadTokenUsage;
}
// v2 `ErrorNotification` wraps the same `TurnError` under `error`.
export interface ErrorNotification {
  threadId: string;
  turnId: string;
  error: TurnError;
  willRetry: boolean;
  [k: string]: unknown;
}

export interface InitializeParams {
  clientInfo: { name: string; title?: string; version?: string };
  capabilities?: Record<string, unknown> | null;
}

export type AskForApproval =
  | "untrusted"
  | "on-request"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    }
  | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ReasoningEffort = string;
export type ThreadHistoryMode = "legacy" | "paginated";

/** Configuration overrides shared by thread/start, thread/resume, and thread/fork. */
export interface ThreadConfigurationOverrides {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  /** Catch-all for `~/.codex/config.toml` keys — where `mcp_servers`,
   *  `model_reasoning_summary`, `hide_agent_reasoning` are passed. */
  config?: Record<string, unknown> | null;
  /** The system prompt. */
  baseInstructions?: string | null;
}

export interface ThreadStartParams extends ThreadConfigurationOverrides {
  /** Persisted history contract for the new thread. */
  historyMode?: ThreadHistoryMode | null;
  dynamicTools?: DynamicToolSpec[] | null;
}

export interface DynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
}

/** Remove fields accepted only by thread/start before resume/fork requests. */
export function toThreadConfigurationOverrides(
  config: ThreadStartParams,
): ThreadConfigurationOverrides {
  const { dynamicTools: _dynamicTools, historyMode: _historyMode, ...overrides } = config;
  return overrides;
}

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

export interface DynamicToolCallResponse {
  contentItems: Array<
    { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
  >;
  success: boolean;
}

export interface ThreadResumeParams extends ThreadConfigurationOverrides {
  threadId: string;
}

export interface ThreadForkParams extends ThreadConfigurationOverrides {
  threadId: string;
  /** Include this provider turn as the fork's final inherited turn. */
  lastTurnId?: string | null;
  /** Exclude this provider turn and every later turn from the fork. */
  beforeTurnId?: string | null;
  ephemeral?: boolean;
}

export interface ThreadRevertParams {
  threadId: string;
  /**
   * Replace a paginated thread's durable history with the prefix before this
   * turn, excluding it and every later turn. Local file changes are untouched.
   */
  beforeTurnId: string;
}

export type UserInput =
  | { type: "text"; text: string; text_elements: never[] }
  | { type: "image"; url: string };

export interface TurnStartParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
  model?: string | null;
  effort?: ReasoningEffort | null;
  approvalPolicy?: AskForApproval | null;
  outputSchema?: unknown | null;
}

export interface TurnSteerParams {
  threadId: string;
  expectedTurnId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export const Method = {
  initialize: "initialize",
  initialized: "initialized",
  accountRead: "account/read",
  accountLoginStart: "account/login/start",
  accountLoginCancel: "account/login/cancel",
  accountLogout: "account/logout",
  accountRateLimitsRead: "account/rateLimits/read",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadFork: "thread/fork",
  threadRevert: "thread/revert",
  threadTurnsList: "thread/turns/list",
  threadUnsubscribe: "thread/unsubscribe",
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  turnInterrupt: "turn/interrupt",
} as const;

export const Notify = {
  accountLoginCompleted: "account/login/completed",
  accountUpdated: "account/updated",
  accountRateLimitsUpdated: "account/rateLimits/updated",
  threadStarted: "thread/started",
  turnStarted: "turn/started",
  turnPlanUpdated: "turn/plan/updated",
  turnCompleted: "turn/completed",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  agentMessageDelta: "item/agentMessage/delta",
  tokenUsageUpdated: "thread/tokenUsage/updated",
  error: "error",
} as const;

/** Server→client request methods Rome must answer. With approvalPolicy:"never"
 *  the approval ones should never fire, but we answer defensively. */
export const ServerRequestMethod = {
  commandApproval: "item/commandExecution/requestApproval",
  fileChangeApproval: "item/fileChange/requestApproval",
  requestUserInput: "item/tool/requestUserInput",
  dynamicToolCall: "item/tool/call",
} as const;
