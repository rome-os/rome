// The model provider port: what the agent context needs from a model it can
// run. Adapters live in agent/infrastructure/model/. Agent model:
// docs/concepts/agents.md. The port narrows one member group at a time, with
// both adapters and every caller moving in the same PR; the target shape is
// in the slice 2 reshape note.
//
// The interface only requires what every model needs: an id, a builtin-tool
// catalog and `openSession`. ModelResolver owns provider priority and concrete
// model selection. Deliberately excludes mid-session control
// (setModel/setPermissionMode/setMcpServers/stopTask) — that vocabulary is
// Claude-SDK-specific and has no place in the provider contract.
//
// The port imports only the SDK's event vocabulary and its own domain. The
// shapes it hands the provider or reads back from it are declared here.

import type {
  AgentEvent,
  ReasoningEffort,
  TurnErrorEvent,
  TurnResultEvent,
} from "@rome-os/app-runtime";
import type { RomeTools } from "./rome-tools.js";

export type ProviderId = "anthropic" | "openai" | "mock";

export type ModelReasoningEffort = ReasoningEffort;

/** An MCP server the provider launches and mounts next to its builtin tools. */
export interface McpServerConfig {
  command: string;
  args: string[];
}

/**
 * Who pays the model provider for a turn. The provider knows its payer and
 * reports it; Rome's usage record carries it as read.
 */
export type ModelFunding = "rome_credits" | "byok" | "subscription" | "unknown";

/**
 * The provider's name for one of its threads. Two equal ids name the same
 * thread, and the id outlives the process. A `resume` with it continues that
 * thread with its history, and a provider that cannot find it fails rather
 * than starting a new thread. Stable for the thread's lifetime and never
 * reassigned (Claude: the SDK session id the adapter chose; Codex: the id the
 * app-server returned). The domain stores and compares it, and reads nothing
 * into its spelling.
 */
export type ModelThreadId = string;

/**
 * The provider's marker for the state of a thread right after one completed
 * turn. Starting from it gives a history equal to the source thread's up to and
 * including that turn, and nothing after it. Minted by the adapter when a turn
 * completes, and meaningful only with the thread it came from (Claude: the uuid
 * of the turn's last assistant message; Codex: the id of the turn). A failed or
 * interrupted turn mints none. Nor does a Claude turn with no assistant message,
 * or a Codex exact fork's turn, which leaves the source's head alone.
 */
export type ModelCheckpointId = string;

/**
 * The id the provider itself gave one turn, as it appears in the provider's
 * bill, logs and events. Set only when the provider minted one (Codex), and
 * never made up by the adapter (Claude has none). The run keeps it with the
 * turn's usage so a charge can be matched to the turn.
 */
export type ModelTurnId = string;

/** Where a completed turn left a model thread. */
export interface ModelPosition {
  provider: ProviderId;
  modelThreadId: ModelThreadId;
  checkpointId: ModelCheckpointId;
}

/** The provider named a turn. A provider that mints no turn id never emits it. */
export interface ModelTurnStartedEvent {
  type: "model_turn_started";
  modelTurnId: ModelTurnId;
}

/** A turn finished: how it ran, and where it left the thread. */
export interface ModelTurnResultEvent extends TurnResultEvent {
  /**
   * The effort the adapter ran the turn at, in the provider's own terms. It may
   * not be the effort the turn asked for: Claude keeps the one its session
   * opened with.
   */
  reasoningEffort: string;
  /** Absent when the turn left no checkpoint. */
  position?: ModelPosition;
}

/** What a model session emits while a turn runs. */
export type ModelTurnActivityEvent = Exclude<AgentEvent, TurnResultEvent | TurnErrorEvent>;

/** The events a model session emits, normalized from the provider's own. */
export type ModelSessionEvent =
  | ModelTurnStartedEvent
  | ModelTurnActivityEvent
  | ModelTurnResultEvent
  | TurnErrorEvent;

export interface ModelProvider {
  /** Stable id used for telemetry and to look the provider up in the registry. */
  readonly id: ProviderId;
  /**
   * Names of tools the provider handles natively. These are Rome-canonical
   * names (Read / Edit / Bash / Glob / Grep / WebSearch / WebFetch / Task) —
   * the agent loader filters yaml `tools:` entries against this set.
   */
  readonly builtinTools: ReadonlySet<string>;
  /**
   * Open a long-lived model session. The returned handle owns the underlying
   * SDK / HTTP client and the input queue. Multiple turns are driven by
   * repeated `sendUserInput()` calls; the consumer drains `events()` for as
   * long as the session is open.
   */
  openSession(params: ModelSessionParams): Promise<ModelSession>;
}

/**
 * How a session gets its thread. `new` opens a thread the provider names;
 * `resume` continues one it named before; `branch` starts from a position on
 * one, with the session configured by these params and not by the source. An
 * `ephemeral` branch is closed after one use, and the provider may run it
 * inside the source thread and roll it back when the branch has the source's
 * model, system prompt, working dir and tools. A `kept` branch gets a thread of
 * its own that the session records. A provider that keeps the source's tools
 * on a branch meets the configuration as far as it can.
 */
export type ThreadStart =
  | { kind: "new" }
  | { kind: "resume"; modelThreadId: ModelThreadId }
  | { kind: "branch"; at: ModelPosition; lifetime: "ephemeral" | "kept" };

/**
 * Value object. The model session's configuration: what the run fixes when
 * it opens the session and keeps for its lifetime, from the model and what it
 * sees first to the environment its builtin tools run in. The run composes it
 * from the agent's configuration and the conversation; the adapter passes it
 * through and changes nothing in it.
 */
export interface ModelSessionConfig {
  model: string;
  systemPrompt: string;
  /** Rome-canonical names, already filtered against `ModelProvider.builtinTools`. */
  builtinTools: string[];
  reasoningEffort?: ModelReasoningEffort;
  /** Provider-native JSON Schema for every final answer. */
  outputSchema?: Record<string, unknown>;
  workingDir?: string;
  /** Only the provider can mount these next to its builtin tools. */
  externalMcpServers?: Record<string, McpServerConfig>;
  /**
   * Set on the shell the builtin tools run in; `undefined` clears a variable
   * the Rome process inherited. The adapter reads none of it.
   */
  env?: Record<string, string | undefined>;
  /**
   * Agentic rounds one turn may take before the provider ends it. Only Claude
   * honours it; it stays while an agent config (`image-gen`) sets it.
   */
  maxTurns?: number;
}

export interface ModelSessionParams {
  config: ModelSessionConfig;
  /**
   * The tools Rome serves the model for this session. The provider mounts
   * each group and calls back with what the model sent; what a tool does and
   * which surface answers it are the run's.
   */
  tools: RomeTools;
  /** The thread the session runs on. The provider names the thread. */
  thread: ThreadStart;
}

export interface ModelUserInput {
  /** Stable identity of an independently submitted conversational input. */
  inputId?: string;
  text: string;
  /** Absolute local paths of images attached to the turn (providers without image-input support ignore them). */
  images?: string[];
  reasoningEffort?: ModelReasoningEffort;
  /** Optional injected tool-result, used for approval continuations. */
  injectedToolResult?: { toolUseId: string; content: unknown };
}

export interface ModelSession {
  readonly providerId: ProviderId;
  readonly model: string;
  /** Single, lifetime stream of events produced by the provider. */
  readonly events: AsyncIterable<ModelSessionEvent>;

  /** The thread this session runs on, once it can be resumed. Claude: after the first assistant message. */
  readonly modelThreadId?: ModelThreadId;

  /** Who pays the model provider for a turn that ends now. Unset when unknown. */
  readonly funding?: ModelFunding;

  /** Push a new user turn. Resolves once the provider accepts it. */
  sendUserInput(input: ModelUserInput): Promise<void>;

  /** Append without interrupting. Only `deferred` is safe to submit again. */
  steerUserInput?(input: ModelUserInput): Promise<"accepted" | "deferred">;

  /** Stop the in-flight turn. The session takes the next input as usual. */
  interrupt(reason?: string): Promise<void>;

  /**
   * Close the session. The events iterable terminates. Idempotent. After
   * close(), sendUserInput() rejects.
   */
  close(): Promise<void>;
}
