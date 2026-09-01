// WebChat trace wire DTOs. Session model: docs/concepts/sessions.md.

import type { AgentPlan, RomeSessionRef } from "@rome-os/app-runtime";
export type {
  AgentInputState,
  InputStatusMessage,
  AgentPlan,
  AgentPlanStep,
  AgentPlanStepStatus,
  RomeSessionType,
} from "@rome-os/app-runtime";

export interface AppRefDto {
  id: string;
  name: string;
  /** Absolute or root-relative URL the client renders with <img src>. */
  iconUrl: string;
}

export type TraceBlockType = TraceBlockDto["type"];

interface TraceBlockBase {
  /** Sub-agent that produced this block: "main" | "envoy" | <subagent>. */
  agent?: string;
}

export type RomeSessionRefDto = RomeSessionRef;

export interface SessionInitBlock extends TraceBlockBase {
  type: "session_init";
  sessionId: string;
  romeSession?: RomeSessionRefDto;
  systemPrompt?: string;
  userPrompt?: string;
  projectPath?: string;
}

export interface TurnStartBlock extends TraceBlockBase {
  type: "turn_start";
  turnId: string;
  sessionId: string;
  userPrompt: string;
}

/** Follows the terminal result or error and closes its turn. */
export interface TurnEndBlock extends TraceBlockBase {
  type: "turn_end";
  turnId: string;
  /** Turn outcome. `interrupted` means the user stopped the turn mid-flight;
   *  it takes precedence over `error`. */
  status: "completed" | "interrupted" | "error";
  /** Turn wall-clock measured by the AgentSession. Distinct from
   *  `accounting.durationMs` on the terminal block, which is the provider's
   *  self-reported per-call duration. */
  durationMs: number;
}

export interface TextBlock extends TraceBlockBase {
  type: "text";
  content: string;
  /** Provider-agnostic role of this text within its turn. `commentary` =
   *  in-turn narration the model emitted between/before tool calls; `final` =
   *  the turn's closing answer (also carried by the terminal `result` block /
   *  the assistant bubble). Sourced from the provider's native terminal signal
   *  (Anthropic `stop_reason`; Codex app-server `phase`). Absent on legacy
   *  blocks persisted before this field existed — treat absence as "unknown"
   *  (not promoted). Deliberately borrows Codex's vocabulary; not Codex-only. */
  turnPhase?: "commentary" | "final";
}

export interface ThinkingBlock extends TraceBlockBase {
  type: "thinking";
  content: string;
}

export interface ToolUseBlock extends TraceBlockBase {
  type: "tool_use";
  tool: string;
  input: unknown;
  /** Provider-issued ID used to pair the matching tool result. */
  id?: string;
  startedAt?: string;
}

export interface ToolResultBlock extends TraceBlockBase {
  type: "tool_result";
  tool: string;
  output: unknown;
  /** Provider-issued ID of the corresponding tool use. */
  toolUseId?: string;
  endedAt?: string;
}

export interface SubagentStartBlock extends TraceBlockBase {
  type: "subagent_start";
  toolUseId: string;
  agentName: string;
  input: unknown;
  sessionId: string;
  turnId: string;
  startedAt?: string;
}

export type SubagentResultBlock =
  | (TraceBlockBase & {
      type: "subagent_result";
      toolUseId: string;
      agentName: string;
      sessionId: string;
      turnId: string;
      status: "completed";
      output: unknown;
      endedAt?: string;
    })
  | (TraceBlockBase & {
      type: "subagent_result";
      toolUseId: string;
      agentName: string;
      sessionId: string;
      turnId: string;
      status: "failed" | "cancelled";
      error: { message: string; code?: string };
      endedAt?: string;
    });

export interface TraceTokenUsage {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TraceContextUsage {
  usedTokens: number;
  windowTokens?: number;
  remainingTokens?: number;
}

/** Read-time usage grouped by the provider/model that produced it. */
export interface TraceModelUsage {
  provider: string;
  model: string;
  usage: TraceTokenUsage;
  costUsd?: number;
  runCount: number;
}

export interface TraceAccounting {
  provider: string;
  model: string;
  usage: TraceTokenUsage;
  context?: TraceContextUsage;
  costUsd?: number;
  numTurns?: number;
  stopReason?: string;
  durationMs?: number;
  rawUsage?: Record<string, unknown>;
  /** Number of descendant subagent runs included in `usage` and `costUsd`.
   *  Derived only for trace reads; never persisted in canonical trace blocks. */
  includedSubagentCount?: number;
  /** Main + descendant usage grouped by provider/model. Like
   *  `includedSubagentCount`, this is derived only on trace reads. */
  usageByModel?: TraceModelUsage[];
}

export interface ResultBlock extends TraceBlockBase {
  type: "result";
  content: string;
  structuredOutput?: unknown;
  accounting?: TraceAccounting;
}

export interface ErrorBlock extends TraceBlockBase {
  type: "error";
  error: string;
  accounting?: TraceAccounting;
  code?:
    | "usage_limit"
    | "auth_revoked"
    | "model_provider_unavailable"
    | "model_unavailable"
    | "no_model_provider_available";
  provider?: "openai" | "anthropic";
  reason?: "not_logged_in" | "quota_exhausted" | "model_access_denied" | "no_available_provider";
}

export interface StructuredOutputBlock extends TraceBlockBase {
  type: "structured_output";
  payload: unknown;
}

export interface PlanUpdateBlock extends TraceBlockBase {
  type: "plan_update";
  plan: AgentPlan;
}

export type TraceBlockDto =
  | SessionInitBlock
  | TurnStartBlock
  | TurnEndBlock
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | SubagentStartBlock
  | SubagentResultBlock
  | ResultBlock
  | ErrorBlock
  | StructuredOutputBlock
  | PlanUpdateBlock;

export interface TraceRunSegment {
  kind: "run";
  /** Stable across upserts for the lifetime of the run. */
  id: string;
  app: AppRefDto;
  count: number;
  /** Paired tool or subagent invocation blocks in time order. */
  blocks: TraceBlockDto[];
  /** Sum of (endedAt − startedAt) over paired steps; undefined if any step
   *  in the run is missing a timestamp. */
  durationMs?: number;
  /** Render order across all segments. Stable across upserts. */
  ordinal: number;
}

export interface TraceBlockSegment {
  kind: "block";
  id: string;
  block: TraceBlockDto;
  ordinal: number;
}

export type TraceSegment = TraceRunSegment | TraceBlockSegment;

export type TraceSubagentStatus = "running" | "completed" | "failed" | "cancelled";

/** Direct child invocation projected from the parent's subagent lifecycle.
 *  `traceSummary` is a read-time aggregation of the canonical child trace;
 *  it is never written back into either trace. */
export interface TraceSubagentSummary {
  toolUseId: string;
  agentName: string;
  sessionId: string;
  turnId: string;
  status: TraceSubagentStatus;
  traceSummary?: TraceSummary;
}

export interface TraceSummary {
  /** Distinct apps in first-appearance order. Deduped across all sub-agents. */
  distinctApps: AppRefDto[];
  /** Count of tool_use blocks across all sub-agents. */
  totalSteps: number;
  /** Direct child invocations; their trace summaries are joined at read time. */
  subagents?: TraceSubagentSummary[];
  /** Wall-clock duration the outermost AgentSession measured for the turn.
   *  Read from the turn's `turn_end` block. */
  totalDurationMs?: number;
  /** Authoritative outcome from the latest `turn_end` block. Absent while the
   *  turn is still running and on legacy traces without lifecycle brackets. */
  turnStatus?: TurnEndBlock["status"];
  /** Per-app invocation totals for the icon-strip tooltip. Keyed by app.id. */
  invocationCounts: Record<string, number>;
  /** True when the turn was interrupted by the user via Stop. */
  stoppedByUser?: boolean;
  /** Terminal agent error for failed turns. Present only when the trace ended
   *  with an error rather than a user stop. */
  terminalError?: string;
  plan?: AgentPlan;
}

export interface TraceSnapshot {
  segments: TraceSegment[];
  summary: TraceSummary;
}

export const TURN_FEEDBACK_RATINGS = ["positive", "negative"] as const;
export type TurnFeedbackRating = (typeof TURN_FEEDBACK_RATINGS)[number];

export function isTurnFeedbackRating(value: unknown): value is TurnFeedbackRating {
  return (TURN_FEEDBACK_RATINGS as readonly unknown[]).includes(value);
}

/** Shared character limit for UI and server validation. */
export const TURN_FEEDBACK_COMMENT_MAX_LENGTH = 2000;

/** Shared character limit for the branch composer and server route. */
export const TURN_BRANCH_PROMPT_MAX_LENGTH = 4000;

export interface TurnFeedback {
  rating: TurnFeedbackRating;
  comment: string | null;
  /** Unix seconds. */
  updatedAt: number;
}
