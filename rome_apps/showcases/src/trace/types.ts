export interface AppRefDto {
  id: string;
  name: string;
  iconUrl: string;
}

interface TraceBlockBase {
  agent?: string;
}

export interface SessionInitBlock extends TraceBlockBase {
  type: "session_init";
  sessionId: string;
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

export interface TurnEndBlock extends TraceBlockBase {
  type: "turn_end";
  turnId: string;
  status: "completed" | "interrupted" | "error";
  durationMs: number;
}

export interface TextBlock extends TraceBlockBase {
  type: "text";
  content: string;
}

export interface ThinkingBlock extends TraceBlockBase {
  type: "thinking";
  content: string;
}

export interface ToolUseBlock extends TraceBlockBase {
  type: "tool_use";
  tool: string;
  input: unknown;
  id?: string;
  startedAt?: string;
}

export interface ToolResultBlock extends TraceBlockBase {
  type: "tool_result";
  tool: string;
  output: unknown;
  toolUseId?: string;
  endedAt?: string;
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
}

export interface StructuredOutputBlock extends TraceBlockBase {
  type: "structured_output";
  payload: unknown;
}

export type TraceBlockDto =
  | SessionInitBlock
  | TurnStartBlock
  | TurnEndBlock
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ResultBlock
  | ErrorBlock
  | StructuredOutputBlock;

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
  blocks: TraceBlockDto[];
  durationMs?: number;
  ordinal: number;
}

export interface TraceBlockSegment {
  kind: "block";
  id: string;
  agent: string;
  agentDisplayName: string;
  block: TraceBlockDto;
  ordinal: number;
}

export type TraceSegment = TraceRunSegment | TraceBlockSegment;

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
