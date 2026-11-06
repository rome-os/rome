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
// Extracted from core/agent-runner.ts with its shapes unchanged. The imports
// from core/ are the shapes it still shares with the run; they go when the
// port is reshaped.

import type { ActionConfig } from "../../actions/types.js";
import type { DeferInput } from "../../core/defer.js";
import type { FacadeToolDef, RoutineActivationGate } from "../../core/mcp-facade.js";
import type { SkillMcpDefinition } from "../../core/skill-catalog.js";
import type { AgentEvent, McpServerConfig, ReasoningEffort } from "../../types.js";
import type { UsageFunding } from "../../usage/events.js";

export type ProviderId = "anthropic" | "openai" | "mock";

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCallContext {
  /** Provider-issued identity of the model tool call. */
  toolUseId: string;
}

export interface ActionMcpDefinition {
  name: string;
  description: string;
  type: ActionConfig["type"];
  complexity: ActionConfig["complexity"];
  speed: ActionConfig["speed"];
  reliability: ActionConfig["reliability"];
  sideEffects: ActionConfig["sideEffects"];
  requiresApproval: boolean;
  cancellable: boolean;
  inputSchema: Record<string, unknown>;
}

// One definition, owned by the skill catalog that produces it.
export type { SkillMcpDefinition };

export type ModelReasoningEffort = ReasoningEffort;

export interface ModelProvider {
  /** Stable id used for telemetry and to look the provider up in the registry. */
  readonly id: ProviderId;
  /** Human-readable label for the dashboard. */
  readonly displayName: string;
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
 * `resume` continues one it named before. The branch of a thread at a
 * checkpoint joins here when `ModelSession.fork` goes.
 */
export type ThreadStart = { kind: "new" } | { kind: "resume"; providerThreadId: string };

export interface ModelSessionParams {
  model: string;
  systemPrompt: string;
  agentName?: string;
  /** Rome Cloud App Store listing id for the app owning `agentName`, when installed from the store. */
  appStoreListingId?: string;
  /**
   * Live getter the MCP facade reads on every tool request, so actions added
   * mid-session (e.g. by `app_management`) become callable in-session. No
   * static-snapshot fallback exists — every caller must supply a real getter.
   */
  getActionCatalog: () => ActionMcpDefinition[];
  /**
   * Live getter the MCP facade reads on every tool request, so skills from
   * apps installed mid-session (e.g. via `app_management`) become
   * discoverable in-session.
   */
  getSkillCatalog: () => SkillMcpDefinition[];
  subagentTools: ModelToolDefinition[];
  /** Provider-native final-response JSON Schema for every model turn. */
  outputSchema?: Record<string, unknown>;
  builtinTools?: string[];
  maxTurns?: number;
  reasoningEffort?: ModelReasoningEffort;
  workingDir?: string;
  /** The channel the session's turns are delivered on, from its key. Shell
   *  tools such as the Discord CLI read it to act as that channel's account. */
  channel?: string;
  /**
   * The agent's text stays in its trace (`policy.finalText: private`), so it
   * reaches the guardian only through its tools.
   */
  textPrivate?: boolean;
  externalMcpServers?: Record<string, McpServerConfig>;
  /** The thread the session runs on. The provider names the thread. */
  thread: ThreadStart;
  /** Provider-owned fork source. Normal application code should not set this. */
  fork?: ModelSessionForkSource;
  /** Execute callbacks; the provider invokes these as MCP tools. */
  executeAction: (name: string, input: unknown) => Promise<unknown>;
  executeSubagent: (
    name: string,
    input: unknown,
    context: ModelToolCallContext,
  ) => Promise<unknown>;
  /** Invoked when the agent calls the `defer` tool: schedules a
   * one-off wakeup back into this same thread. Absent for sessions with no
   * live thread to wake. */
  executeDefer?: (input: DeferInput) => Promise<unknown>;
  /** See FacadeParams.sessionTools. */
  sessionTools?: FacadeToolDef[];
  /** See FacadeParams.routineActivation. */
  routineActivation?: RoutineActivationGate;
  /**
   * Whether the consuming surface can render interactive inline UI
   * (`propose_routine` cards, app components). True only for webchat-bound
   * sessions (dashboard + desktop); other channels skip the tools so the model
   * doesn't dead-end waiting for UI no one will deliver.
   */
  supportsInteractiveSurface?: boolean;
  /**
   * True when the session must keep advertising the interactive-surface tool
   * catalog but nothing drains its stream to mount UI — exact-mode forked
   * turns, whose model-visible prefix (system prompt + tools) must stay
   * byte-identical to their webchat source while no webchat drain exists to
   * render cards. The interactive tools' *runtime*
   * degrades to the non-interactive fallbacks (ask_question relays prose;
   * propose_routine refuses) instead of claiming UI was
   * delivered. See FacadeParams.interactiveSurfaceDetached.
   */
  interactiveSurfaceDetached?: boolean;
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

export type ModelSessionForkMode = "ephemeral" | "thread";

export interface ModelSessionForkParams {
  /** Ephemeral forks are closed after one use; thread forks may be persisted. */
  mode?: ModelSessionForkMode;
  /**
   * Whether the fork may change the source session's runtime configuration.
   * Providers can use exact-mode knowledge to preserve provider-specific cache
   * lineage when the model and prompt configuration are unchanged.
   */
  configurationMode?: "isolated" | "exact";
  /** Provider-native checkpoint to include as the fork's final source turn. */
  sourceCheckpoint?: string;
}

export interface ModelSessionForkSource {
  sourceProviderThreadId: string;
  mode: ModelSessionForkMode;
  sourceCheckpoint?: string;
}

export type ModelSessionForkOpenParams = Omit<ModelSessionParams, "thread" | "fork">;

export interface ModelSessionFork {
  readonly providerId: ProviderId;
  readonly sourceProviderThreadId: string;
  readonly mode: ModelSessionForkMode;
  readonly providerThreadId?: string;

  open(params: ModelSessionForkOpenParams): Promise<ModelSession>;
}

export interface ModelSession {
  readonly providerId: ProviderId;
  readonly model: string;
  /**
   * Effort the provider applied to its most recent turn, in the provider's
   * own terminology (for example `xhigh` for Claude and Codex). A provider
   * that fixes effort when the session opens may report it before the first
   * turn. Unset when the provider reports none.
   */
  readonly appliedReasoningEffort?: string;
  /** A disposed provider execution must be reopened before another turn. */
  readonly isClosed?: boolean;
  /** Single, lifetime stream of AgentMessages produced by the provider. */
  readonly events: AsyncIterable<AgentEvent>;

  /**
   * Provider-specific thread id, set after the first turn for providers that
   * generate their own (e.g. Codex). Used by the session manager to persist
   * the id for future resume.
   */
  providerThreadId?: string;

  /** Opaque checkpoint for the most recent successfully completed provider turn. */
  readonly lastCompletedTurnCheckpoint?: string;

  /**
   * The provider's own id for the most recent turn that reached it, whatever
   * its outcome. Unset for providers that mint no turn ids of their own.
   */
  readonly lastProviderTurnId?: string;

  /** Who pays the model provider for a turn that ends now. Unset when unknown. */
  readonly funding?: UsageFunding;

  /** Push a new user turn. Resolves once the provider accepts it. */
  sendUserInput(input: ModelUserInput): Promise<void>;

  /** Append without interrupting. Only `deferred` is safe to submit again. */
  steerUserInput?(input: ModelUserInput): Promise<"accepted" | "deferred">;

  /** Create an isolated provider-owned branch from this live session. */
  fork(params: ModelSessionForkParams): Promise<ModelSessionFork>;

  /** Stop the in-flight turn. The provider may dispose of its execution. */
  interrupt(reason?: string): Promise<void>;

  /**
   * Close the session. The events iterable terminates. Idempotent. After
   * close(), sendUserInput() rejects.
   */
  close(): Promise<void>;
}
