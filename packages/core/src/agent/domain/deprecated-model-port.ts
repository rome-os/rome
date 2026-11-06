// The model port as the adapters implement it today. Kept whole until they
// implement ./model-port.ts, then deleted. New code uses ./model-port.ts.
//
// Extracted from core/agent-runner.ts with its shapes unchanged. The imports
// from core/ are the shapes it still shares with the run.

import type { ActionConfig } from "../../actions/types.js";
import type { DeferInput } from "../../core/defer.js";
import type { FacadeToolDef, RoutineActivationGate } from "../../core/mcp-facade.js";
import type { SkillMcpDefinition } from "../../core/skill-catalog.js";
import type { AgentEvent, McpServerConfig } from "../../types.js";
import type { UsageFunding } from "../../usage/events.js";

import type { ModelReasoningEffort, ModelUserInput, ProviderId } from "./model-port.js";
import type { ModelToolCallContext, ModelToolDefinition } from "./rome-tools.js";

// Shapes the two ports share, so the adapters implement one definition.
export type {
  ModelReasoningEffort,
  ModelToolCallContext,
  ModelToolDefinition,
  ModelUserInput,
  ProviderId,
};

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

/** @deprecated Implement the port in ./model-port.ts. */
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

/** @deprecated Implement the port in ./model-port.ts. */
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
  /**
   * The session identifier, a bare UUID. The Anthropic provider passes a new
   * session's id to Claude Code as `--session-id`, which rejects anything
   * else.
   */
  sessionId: string;
  /**
   * When true, the provider has never seen `sessionId`, so it may use it as
   * the new conversation's id. When false, the id may already be taken, and
   * the provider resumes only through `providerThreadId`.
   */
  isNewSession?: boolean;
  /**
   * Provider-specific thread/session id from a previous session, used for
   * resume. Codex generates its own opaque thread id that must be passed
   * back to `resumeThread()`; Anthropic captures the SDK transcript's id.
   */
  providerThreadId?: string;
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

export type ModelSessionForkMode = "ephemeral" | "thread";

/** @deprecated Implement the port in ./model-port.ts. */
export interface ModelSessionForkParams {
  /** Rome session id to assign to the forked provider session. */
  sessionId: string;
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
  sourceSessionId: string;
  sourceProviderThreadId?: string;
  mode: ModelSessionForkMode;
  sourceCheckpoint?: string;
}

export type ModelSessionForkOpenParams = Omit<
  ModelSessionParams,
  "sessionId" | "isNewSession" | "providerThreadId" | "fork"
>;

/** @deprecated Implement the port in ./model-port.ts. */
export interface ModelSessionFork {
  readonly providerId: ProviderId;
  readonly sessionId: string;
  readonly sourceSessionId: string;
  readonly sourceProviderThreadId?: string;
  readonly mode: ModelSessionForkMode;
  readonly providerThreadId?: string;

  open(params: ModelSessionForkOpenParams): Promise<ModelSession>;
}

/** @deprecated Implement the port in ./model-port.ts. */
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
