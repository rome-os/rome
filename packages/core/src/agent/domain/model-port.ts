// The model port: what the agent context needs from a model it can run, and
// nothing it can do without. Adapters live in agent/infrastructure/model/
// and implement ModelProvider; the run implements RomeTools (./rome-tools.ts)
// and hands it in. Agent model: docs/concepts/agents.md.
//
// The port knows models, threads, positions and builtin tools. It knows
// nothing of agents, sessions, chats or connected accounts: the resolver
// picks the provider and model in front of it, the session stores what it
// returns, and what a turn cost travels on the terminal event's accounting.
// Until the adapters implement this port they implement
// ./deprecated-model-port.ts.

import type {
  AgentAccounting,
  AgentBlockEvent,
  AgentDeltaEvent,
  InputStatusEvent,
  PlanUpdateEvent,
  ReasoningEffort,
  StructuredOutputEvent,
  TurnErrorEvent,
  TurnResultEvent,
} from "@rome-os/app-runtime";
import type { RomeTools, ToolUseId } from "./rome-tools.js";

/** Value. Names a provider in the domain. The adapters give a name its behaviour. */
export type ProviderId = "anthropic" | "openai" | "mock";

/** Value. The provider's name for one of its threads. Opaque to the domain. */
export type ProviderThreadId = string;

/**
 * Value. The provider's marker for where a turn left its thread. Opaque to
 * the domain; each provider spells it its own way.
 */
export type CheckpointId = string;

/** Value. The provider's own id for a turn. Opaque to the domain. */
export type ProviderTurnId = string;

/** Value. A model as the provider names it (`claude-opus-4-1`, `gpt-5-codex`). */
export type ModelName = string;

/** Value. The run's identity for one user input, so a steer can be confirmed. */
export type InputId = string;

export type ModelReasoningEffort = ReasoningEffort;

/**
 * Value object. Where a completed turn left a provider thread. Minted by the
 * provider, recorded with the turn, handed back to `fork`.
 */
export interface ProviderPosition {
  provider: ProviderId;
  providerThreadId: ProviderThreadId;
  checkpointId: CheckpointId;
}

/** Value object. An MCP server the guardian configured, as a command to spawn. */
export interface ExternalMcpServer {
  command: string;
  args: string[];
}

/**
 * Value object. What the model sees before the conversation. Built by the
 * run; the adapter passes it through and changes nothing in it.
 */
export interface ModelPrefix {
  model: ModelName;
  systemPrompt: string;
  /** Rome-canonical names, already filtered against `ModelProvider.builtinTools`. */
  builtinTools: string[];
  reasoningEffort?: ModelReasoningEffort;
  /** Provider-native JSON Schema for every final answer. */
  outputSchema?: Record<string, unknown>;
  workingDir?: string;
  /** Only the provider can mount these next to its builtin tools. */
  externalMcpServers?: Record<string, ExternalMcpServer>;
  /** Set on the shell the builtin tools run in. The adapter reads none of it. */
  env?: Record<string, string>;
  /**
   * The agent's text stays in its trace and reaches the guardian only
   * through its tools. The adapter turns off its model's nudges toward
   * visible text; the run cannot spell those without knowing the provider.
   */
  textPrivate?: boolean;
}

/**
 * Value object. Which provider thread a model session opens on. `new` starts
 * a thread that has seen nothing; `resume` continues one the provider named.
 */
export type ThreadStart = { kind: "new" } | { kind: "resume"; providerThreadId: ProviderThreadId };

export interface OpenModelSessionParams {
  prefix: ModelPrefix;
  thread: ThreadStart;
  tools: RomeTools;
}

export interface ModelProvider {
  readonly id: ProviderId;
  /** Tools the provider runs itself, by Rome-canonical name. */
  readonly builtinTools: ReadonlySet<string>;
  /** Open a model session on a thread. The provider names the thread. */
  open(params: OpenModelSessionParams): Promise<ModelSession>;
}

/** Value object. One user input to a session. A turn may consume several. */
export interface ModelUserInput {
  inputId?: InputId;
  text: string;
  /** Absolute local paths, for providers that take images. */
  images?: string[];
  reasoningEffort?: ModelReasoningEffort;
  /** The answer to a tool approval, continuing the turn that asked. */
  injectedToolResult?: { toolUseId: ToolUseId; content: unknown };
}

/** Value. Who pays the provider for a session's turns. `unknown` when the provider has not said. */
export type ModelFunding = "rome_credits" | "byok" | "subscription" | "unknown";

/**
 * Value object. What a turn cost, with what the usage recorder needs beyond
 * what apps see: the two members below stay inside Rome and leave the event
 * before it reaches an app's turn hooks.
 */
export interface ModelTurnAccounting extends AgentAccounting {
  /** The provider's own id for the turn, for reconciliation with its bill. */
  providerTurnId?: ProviderTurnId;
  /** The effort the provider applied, in its own terms (`xhigh`, `max`). */
  reasoningEffort?: string;
}

export interface ModelTurnResultEvent extends Omit<TurnResultEvent, "accounting"> {
  accounting?: ModelTurnAccounting;
}

export interface ModelTurnErrorEvent extends Omit<TurnErrorEvent, "accounting"> {
  accounting?: ModelTurnAccounting;
}

/**
 * The events a model session emits, in Rome's vocabulary. Provider-native
 * units become these inside the adapter and nowhere else. No turn brackets:
 * `turn_start`, `turn_end`, the subagent events, the interactive cards,
 * usage and spans are the run's. Every turn the adapter started ends with
 * exactly one `result` or `error` carrying its accounting, after an
 * interrupt too. Only a stream that throws ends a turn without one; the run
 * then records the session's `funding` and nothing else.
 */
export type ModelSessionEvent =
  | AgentBlockEvent
  | AgentDeltaEvent
  | InputStatusEvent
  | PlanUpdateEvent
  | StructuredOutputEvent
  | ModelTurnResultEvent
  | ModelTurnErrorEvent;

/**
 * Live handle on one open provider thread. Owns the provider's client and
 * the input queue. One lifetime stream of events across all its turns.
 */
export interface ModelSession {
  /** The model that runs, after any substitution the provider made. */
  readonly model: ModelName;
  /** The thread this session runs on, once the provider has named it. */
  readonly providerThreadId?: ProviderThreadId;
  /** Disposed by an interrupt or a close; a new turn needs a new session. */
  readonly isClosed: boolean;
  readonly events: AsyncIterable<ModelSessionEvent>;
  /**
   * Who pays for this session's turns. Known when the session opens, from
   * the credentials or process it runs on, so a turn with no terminal event
   * is still recorded against the right payer.
   */
  readonly funding: ModelFunding;
  /**
   * Where the most recent completed turn left the thread. Set at the turn's
   * `result`, cleared when the next turn starts, readable after `close()`.
   * Absent after an interrupted or failed turn.
   */
  readonly lastPosition?: ProviderPosition;

  /** Queue an input. Resolves once the provider accepts it. */
  sendUserInput(input: ModelUserInput): Promise<void>;
  /**
   * Add an input to the running turn without interrupting it. `deferred`
   * means the provider did not take it and it may be sent again. A provider
   * without it takes the input as the next turn.
   */
  steerUserInput?(input: ModelUserInput): Promise<"accepted" | "deferred">;
  /** A new thread branched from this one. Refuses while a turn is running. */
  fork(params: ModelSessionForkParams): Promise<ModelSessionFork>;
  /** Stop the running turn. The provider may dispose its client. */
  interrupt(): Promise<void>;
  /** End the session; `events` terminates. Idempotent. */
  close(): Promise<void>;
}

/** Value object. How to branch a thread. */
export interface ModelSessionForkParams {
  /**
   * Where to branch. Absent branches at the head. The provider refuses a
   * position on another provider or another thread.
   */
  at?: ProviderPosition;
  /**
   * `ephemeral` is closed after one use; `kept` gets a thread of its own
   * that the session may record.
   */
  lifetime: "ephemeral" | "kept";
}

export interface ModelSessionForkOpenParams {
  prefix: ModelPrefix;
  tools: RomeTools;
}

/**
 * The branch before it is opened. Minted under the source's lock, opened
 * outside it, so the source's later turns are not held.
 */
export interface ModelSessionFork {
  /**
   * The child's thread, once opened. Absent when the provider ran the turn
   * inside the source thread and rolled it back; such a child has no thread
   * of its own to record.
   */
  readonly providerThreadId?: ProviderThreadId;
  open(params: ModelSessionForkOpenParams): Promise<ModelSession>;
}
