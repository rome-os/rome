export interface AppRefDto {
  id: string;
  name: string;
  iconUrl: string;
}

interface TraceEventBase {
  agent?: string;
}

export interface SessionInitEvent extends TraceEventBase {
  type: "session_init";
  sessionId: string;
  systemPrompt?: string;
  userPrompt?: string;
  projectPath?: string;
}

export interface TurnStartEvent extends TraceEventBase {
  type: "turn_start";
  turnId: string;
  sessionId: string;
  userPrompt: string;
}

export interface TurnEndEvent extends TraceEventBase {
  type: "turn_end";
  turnId: string;
  status: "completed" | "interrupted" | "error";
  durationMs: number;
}

export interface TextBlock extends TraceEventBase {
  type: "text";
  content: string;
}

export interface ThinkingBlock extends TraceEventBase {
  type: "thinking";
  content: string;
}

export interface ToolUseBlock extends TraceEventBase {
  type: "tool_use";
  tool: string;
  input: unknown;
  id?: string;
  startedAt?: string;
}

export interface ToolResultBlock extends TraceEventBase {
  type: "tool_result";
  tool: string;
  output: unknown;
  toolUseId?: string;
  endedAt?: string;
  /** Whether the call failed. Absent on results recorded before Rome set it,
   *  and from producers that cannot tell. */
  isError?: boolean;
}

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
}

export interface ResultEvent extends TraceEventBase {
  type: "result";
  content: string;
  structuredOutput?: unknown;
  accounting?: TraceAccounting;
}

export interface TraceErrorEvent extends TraceEventBase {
  type: "error";
  error: string;
  accounting?: TraceAccounting;
}

export interface StructuredOutputEvent extends TraceEventBase {
  type: "structured_output";
  payload: unknown;
}

export type TraceEventDto =
  | SessionInitEvent
  | TurnStartEvent
  | TurnEndEvent
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ResultEvent
  | TraceErrorEvent
  | StructuredOutputEvent;

// Conversation-flow blocks captured from the agent's *assistant* message (not
// the trace steps): the reply text plus any interaction card it surfaced. The
// chat column renders these — the trace is only a collapsed subtitle — so to
// match /chat the replay renders them in the agent turn's body. Stored on a
// trace's `metadata.replyBlocks` at import, populated only when a turn actually
// carries a card (text-only turns keep using the snapshot's final message).
export interface ReplyTextBlock {
  type: "text";
  content: string;
}

export interface ReplyInteractionBlock {
  type: "pending_interaction";
  toolUseId: string;
  appId?: string;
  render: { componentId: string; props?: Record<string, unknown>; builtin?: boolean };
  /** The guardian's resolved answer, from the matching `interaction_result`. */
  result?: Record<string, unknown>;
}

export type ReplyBlock = ReplyTextBlock | ReplyInteractionBlock;

export interface TraceRunSegment {
  kind: "run";
  id: string;
  agent: string;
  agentDisplayName: string;
  app: AppRefDto;
  count: number;
  blocks: TraceEventDto[];
  durationMs?: number;
  ordinal: number;
}

export interface TraceEventSegment {
  kind: "block";
  id: string;
  agent: string;
  agentDisplayName: string;
  block: TraceEventDto;
  ordinal: number;
}

export type TraceSegment = TraceRunSegment | TraceEventSegment;

export interface TraceSummary {
  distinctApps: AppRefDto[];
  totalSteps: number;
  totalDurationMs?: number;
  invocationCounts: Record<string, number>;
  stoppedByUser?: boolean;
  terminalError?: string;
}

export interface TraceSnapshot {
  segments: TraceSegment[];
  summary: TraceSummary;
}

export type AgentDisplayNameResolver = (agentId: string) => string;

export interface AppResolver {
  resolveTool(block: ToolUseBlock): AppRefDto;
}
