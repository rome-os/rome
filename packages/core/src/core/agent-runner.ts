import { v4 as uuidv4 } from "uuid";
import type { AgentMessage, McpServerConfig, ReasoningEffort } from "../types.js";
import type { ActionConfig } from "../actions/types.js";
import type { DeferInput } from "./defer.js";
import { type ForkRunParams, type RunParams } from "./types.js";
import type { AgentSessionManager } from "./agent-session.js";
import type { AgentLoader } from "./agent-loader.js";
import { createLogger } from "../logger.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { AgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import {
  AgentTraceRecorder,
  recordAgentTraceBestEffort,
  resolveRomeSessionId,
  resolveRomeSessionType,
  shouldPersistAgentTrace,
} from "./agent-trace-recorder.js";
import { isCoreMainAgentId } from "../apps/artifact-id.js";

const log = createLogger("agent-runner");

// ModelProvider abstraction. Agent model: docs/concepts/agents.md.
//
// The interface only requires what every model needs: an id, a builtin-tool
// catalog and `openSession`. ModelResolver owns provider priority and concrete
// model selection. Deliberately excludes mid-session control
// (setModel/setPermissionMode/setMcpServers/stopTask) — that vocabulary is
// Claude-SDK-specific and has no place in the provider contract.

export type ProviderId = "anthropic" | "openai" | "mock";
export type ModelTier = "large" | "medium" | "small";

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

export interface SkillMcpDefinition {
  name: string;
  description: string;
  tools?: string[];
  content: string;
  ownerType: "core" | "app";
  ownerId: string;
}

export interface HandbackSpec {
  /** JSON Schema describing a candidate shown for guardian approval. */
  schema: Record<string, unknown>;
}

export type ModelReasoningEffort = ReasoningEffort;

/**
 * Legacy one-turn invocation parameters retained for tests and the
 * internal `runOneTurn` shim used by mock providers. Production code should
 * not construct `ModelRunParams` directly — use `ModelSessionParams` +
 * `sendUserInput` via `AgentSessionManager`.
 */
export interface ModelRunParams {
  model: string;
  systemPrompt: string;
  prompt: string;
  actionCatalog: ActionMcpDefinition[];
  skillCatalog: SkillMcpDefinition[];
  subagentTools: ModelToolDefinition[];
  outputSchema?: Record<string, unknown>;
  handback?: HandbackSpec;
  builtinTools?: string[];
  maxTurns?: number;
  reasoningEffort?: ModelReasoningEffort;
  sessionId?: string;
  isNewSession?: boolean;
  workingDir?: string;
  externalMcpServers?: Record<string, McpServerConfig>;
  executeAction: (name: string, input: unknown) => Promise<unknown>;
  executeSubagent: (
    name: string,
    input: unknown,
    context: ModelToolCallContext,
  ) => Promise<unknown>;
  executeSubmitOutput?: (input: unknown) => Promise<unknown>;
}

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
  /** Conversational candidate/approval flow; separate from final output. */
  handback?: HandbackSpec;
  builtinTools?: string[];
  maxTurns?: number;
  reasoningEffort?: ModelReasoningEffort;
  workingDir?: string;
  externalMcpServers?: Record<string, McpServerConfig>;
  /**
   * The session identifier; `isNewSession` selects whether the provider
   * treats it as fresh or as a resumed session. (Resume vs. new is a generic
   * streaming-provider concept — not Anthropic-specific.)
   */
  sessionId: string;
  /** When true, treat `sessionId` as a fresh id; otherwise resume it. */
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
  /** Invoked when the agent calls the `submit_output` tool. */
  executeSubmitOutput?: (input: unknown) => Promise<unknown>;
  /** Invoked when the agent calls the `defer` tool: schedules a
   * one-off wakeup back into this same thread. Absent for sessions with no
   * live thread to wake. */
  executeDefer?: (input: DeferInput) => Promise<unknown>;
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
   * render cards or resolve handbacks. The interactive tools' *runtime*
   * degrades to the non-interactive fallbacks (ask_question relays prose;
   * propose_routine / confirm_output refuse) instead of claiming UI was
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

export interface ModelSessionFork {
  readonly providerId: ProviderId;
  readonly sessionId: string;
  readonly sourceSessionId: string;
  readonly sourceProviderThreadId?: string;
  readonly mode: ModelSessionForkMode;
  readonly providerThreadId?: string;

  open(params: ModelSessionForkOpenParams): Promise<ModelSession>;
}

export interface ModelSession {
  readonly providerId: ProviderId;
  readonly model: string;
  /** A disposed provider execution must be reopened before another turn. */
  readonly isClosed?: boolean;
  /** Single, lifetime stream of AgentMessages produced by the provider. */
  readonly events: AsyncIterable<AgentMessage>;

  /**
   * Provider-specific thread id, set after the first turn for providers that
   * generate their own (e.g. Codex). Used by the session manager to persist
   * the id for future resume.
   */
  providerThreadId?: string;

  /** Opaque checkpoint for the most recent successfully completed provider turn. */
  readonly lastCompletedTurnCheckpoint?: string;

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

/**
 * Synthesize a `ModelSession` from a legacy one-turn `run` callback.
 * Used by mock providers (and any test harness) that don't own a real
 * long-lived SDK Query: each `sendUserInput` consumes one `run()` invocation
 * and drains its messages into the session's events stream.
 */
export function createSessionFromRun(
  providerId: ProviderId,
  run: (params: ModelRunParams) => AsyncIterable<AgentMessage>,
  params: ModelSessionParams,
): ModelSession {
  // Standard async-queue: emit() either hands the value to a waiting
  // consumer (resolvers FIFO) or buffers it for the next next() call. Don't
  // share a single `pending` slot — back-to-back emits would clobber each
  // other since the consumer hasn't had a chance to await again yet.
  const buffer: AgentMessage[] = [];
  const resolvers: Array<(item: IteratorResult<AgentMessage>) => void> = [];
  let closed = false;

  const emit = (msg: AgentMessage) => {
    if (closed) return;
    if (resolvers.length > 0) {
      const r = resolvers.shift()!;
      r({ value: msg, done: false });
    } else {
      buffer.push(msg);
    }
  };

  const events: AsyncIterable<AgentMessage> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<AgentMessage>> {
          if (buffer.length > 0) {
            return { value: buffer.shift()!, done: false };
          }
          if (closed) return { value: undefined as never, done: true };
          return await new Promise<IteratorResult<AgentMessage>>((resolve) => {
            resolvers.push(resolve);
          });
        },
      };
    },
  };

  return {
    providerId,
    model: params.model,
    events,
    async sendUserInput(input: ModelUserInput): Promise<void> {
      // ModelRunParams is a per-turn snapshot for legacy `run()`-based mock
      // providers — call the getters here so each turn sees the current view.
      const runParams: ModelRunParams = {
        model: params.model,
        systemPrompt: params.systemPrompt,
        prompt: input.text,
        actionCatalog: params.getActionCatalog(),
        skillCatalog: params.getSkillCatalog(),
        subagentTools: params.subagentTools,
        outputSchema: params.outputSchema,
        handback: params.handback,
        builtinTools: params.builtinTools,
        maxTurns: params.maxTurns,
        reasoningEffort: input.reasoningEffort ?? params.reasoningEffort,
        sessionId: params.sessionId,
        isNewSession: params.isNewSession,
        workingDir: params.workingDir,
        externalMcpServers: params.externalMcpServers,
        executeAction: params.executeAction,
        executeSubagent: params.executeSubagent,
        executeSubmitOutput: params.executeSubmitOutput,
      };
      for await (const msg of run(runParams)) {
        emit(msg);
      }
    },
    async fork(): Promise<ModelSessionFork> {
      throw new Error("ModelSession fork is not supported by this provider");
    },
    async interrupt(): Promise<void> {},
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      while (resolvers.length > 0) {
        const r = resolvers.shift()!;
        r({ value: undefined as never, done: true });
      }
    },
  };
}

/**
 * A `ModelSession` for a **code-backed agent**: one whose turns
 * are always produced by a turn-middleware rather than a model. It opens no
 * provider query — nothing to resume, nothing to bill, no background SDK stream
 * that could error — so the events iterable simply parks until `close()`.
 *
 * For a correctly-configured code-backed agent a turn middleware short-circuits
 * every turn, so `sendUserInput` is never reached. If it is (no middleware
 * matched — a misconfiguration), the turn is terminated gracefully with a
 * fallback result rather than hanging, so the session never wedges.
 */
export function createNullModelSession(params: ModelSessionParams): ModelSession {
  const buffer: AgentMessage[] = [];
  const resolvers: Array<(item: IteratorResult<AgentMessage>) => void> = [];
  let closed = false;

  const emit = (msg: AgentMessage) => {
    if (closed) return;
    if (resolvers.length > 0) {
      resolvers.shift()!({ value: msg, done: false });
    } else {
      buffer.push(msg);
    }
  };

  const events: AsyncIterable<AgentMessage> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<AgentMessage>> {
          if (buffer.length > 0) return { value: buffer.shift()!, done: false };
          if (closed) return { value: undefined as never, done: true };
          return await new Promise<IteratorResult<AgentMessage>>((resolve) => {
            resolvers.push(resolve);
          });
        },
      };
    },
  };

  const FALLBACK =
    "This conversation is handled by code, not a model, and no handler took this turn. You can start chatting with Rome normally.";

  return {
    providerId: "mock",
    model: params.model,
    events,
    async sendUserInput(): Promise<void> {
      emit({ type: "text", content: FALLBACK });
      emit({ type: "result", content: FALLBACK });
    },
    async fork(): Promise<ModelSessionFork> {
      throw new Error("a code-backed agent session cannot fork");
    },
    async interrupt(): Promise<void> {},
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      while (resolvers.length > 0) {
        resolvers.shift()!({ value: undefined as never, done: true });
      }
    },
  };
}

// AgentRunner — thin shim over AgentSessionManager: acquires the session for
// a given (agentName, channelThreadKey), pushes one turn, and yields the
// events.

export class AgentRunner {
  constructor(
    private agentSessionManager: AgentSessionManager,
    private agentLoader?: AgentLoader,
    private webchatRepo?: WebChatRepository,
    private turnStreams?: AgentTurnStreamRegistry,
  ) {}

  /**
   * Returns true when the named agent is loaded in the catalog. Lets callers
   * (e.g. the inbox message handler) gracefully fall back when a channel is
   * configured to route to an agent that has been uninstalled. Returns true
   * when no AgentLoader was injected (legacy construction paths in tests) so
   * behaviour is unchanged for those callers.
   */
  hasAgent(name: string): boolean {
    if (!this.agentLoader) return true;
    return this.agentLoader.has(name);
  }

  async *run(params: RunParams): AsyncIterable<AgentMessage> {
    // Synthetic key for keyless invocations (e.g. ad-hoc envoy validation
    // runs). Real conversations always pass a `channelThreadKey`.
    const requestedChannelThreadKey = params.channelThreadKey ?? `${params.agentName}:${uuidv4()}`;
    const explicitSessionId = params.sessionId;

    log.info("agent run started", {
      agent: params.agentName,
      channelThreadKey: explicitSessionId ? undefined : requestedChannelThreadKey,
      sessionId: params.sessionId,
      promptPreview: params.prompt.slice(0, 200),
    });

    const init = {
      workingDir: params.workingDir,
      threadContext: params.threadContext,
      romeSessionId: params.romeSessionId,
      sharedContext: params.sharedContext,
      contextSuffix: params.contextSuffix,
      platformMessageId: params.platformMessageId,
    };
    const session = explicitSessionId
      ? await this.acquireExplicitSession(explicitSessionId, params.agentName, init)
      : await this.agentSessionManager.acquire(
          { agentName: params.agentName, channelThreadKey: requestedChannelThreadKey },
          init,
        );
    const agentName = session.key.agentName;
    // An explicit sessionId is the source of truth for continuations. Use the
    // canonical key returned by the session row rather than requiring callers
    // to carry a duplicate channelThreadKey that can drift from it.
    const channelThreadKey = session.key.channelThreadKey;

    const boundRomeSessionId = session.romeSessionId ?? params.romeSessionId;
    const romeSessionId = resolveRomeSessionId({
      agentName,
      agentSessionId: session.sessionId,
      romeSessionId: boundRomeSessionId,
      channelThreadKey,
      threadContext: params.threadContext,
    });
    const romeSessionType = resolveRomeSessionType({ threadContext: params.threadContext });

    // sendTurn is sync — turnId is allocated by AgentSession
    // and surfaced on the stream's turn_start event.
    const handle = session.sendTurn(
      { prompt: params.prompt, images: params.images },
      {
        threadContext: params.threadContext,
        sharedContext: params.sharedContext,
        romeSessionId,
        romeSessionType,
        replyTo: params.replyTo,
        initiatedBy: params.initiatedBy ?? "user",
      },
    );
    if (this.webchatRepo && boundRomeSessionId && params.platformMessageId) {
      await this.webchatRepo.assignConversationMessageTurn(
        romeSessionId,
        params.platformMessageId,
        handle.turnId,
      );
    }

    const recorder =
      this.webchatRepo && shouldPersistAgentTrace(params.threadContext)
        ? new AgentTraceRecorder({
            webchatRepo: this.webchatRepo,
            agentName,
            agentSessionId: session.sessionId,
            romeSessionId,
            existingSessionId: boundRomeSessionId ? romeSessionId : undefined,
            channelThreadKey,
            turnId: handle.turnId,
            threadContext: params.threadContext,
            persistTranscript: true,
            persistUserTranscript: !boundRomeSessionId,
          })
        : null;

    for await (const msg of handle.events) {
      if (recorder) {
        await recordAgentTraceBestEffort(recorder, msg, log, {
          turnId: handle.turnId,
          source: "agent-runner",
        });
      }
      yield msg;
    }

    log.info("agent run completed", {
      agent: agentName,
      sessionId: session.sessionId,
    });
  }

  private async acquireExplicitSession(
    sessionId: string,
    agentName: string,
    init: Parameters<AgentSessionManager["acquire"]>[1],
  ) {
    if (!this.agentSessionManager.acquireBySessionId) {
      throw new Error("AgentSessionManager cannot resume by explicit session id");
    }
    return await this.agentSessionManager.acquireBySessionId(sessionId, agentName, init);
  }

  async *runForked(params: ForkRunParams): AsyncIterable<AgentMessage> {
    const source = this.agentSessionManager.peek({
      agentName: params.agentName,
      channelThreadKey: params.channelThreadKey,
    });
    if (!source) {
      throw new Error("Cannot fork agent session because the source session is not live");
    }
    if (source.sessionId !== params.sourceSessionId) {
      throw new Error("Cannot fork agent session because the source session id does not match");
    }
    if (!source.runForkedTurn) {
      throw new Error(
        "Cannot fork agent session because the source session does not support forks",
      );
    }

    log.info("forked agent run started", {
      agent: params.agentName,
      sourceSessionId: params.sourceSessionId,
      channelThreadKey: params.channelThreadKey,
      mode: params.mode ?? "isolated",
      promptPreview: params.prompt.slice(0, 200),
    });

    // Forked turns persist like action runs: the fork gets its own rome
    // session (type "fork", linked to its parent) and the turn's trace lands
    // there, so the trajectory shows up under /sessions. The fork mints its
    // session/turn ids inside runForkedTurn, so the recorder can only be
    // attached once turn_start surfaces them. Not gated on
    // shouldPersistAgentTrace: that gate exists because the webchat HTTP
    // route owns live webchat persistence, but no route owns a forked turn.
    let recorder: AgentTraceRecorder | null = null;
    let forkTurnId: string | undefined;
    let liveStream: ReturnType<AgentTurnStreamRegistry["register"]> | null = null;
    try {
      for await (const message of source.runForkedTurn({
        prompt: params.prompt,
        tier: params.tier,
        mode: params.mode,
        sourceCheckpoint: params.sourceCheckpoint,
        threadContext: params.threadContext,
      })) {
        if (!forkTurnId && message.type === "turn_start") {
          forkTurnId = message.turnId;
          recorder = await this.createForkTraceRecorder(params, message, source.romeSessionId);
          if (this.turnStreams) {
            try {
              // Forks have their own session and trace, so publish them through
              // the same late-attach registry as Child turns. They deliberately
              // omit `interrupt`: AgentSession cannot currently stop one fork
              // without risking the source session that owns it.
              liveStream = this.turnStreams.register({
                sessionId: message.sessionId,
                turnId: message.turnId,
                agentName: params.agentName,
              });
            } catch (err) {
              // Live inspection is best-effort and must never abort the fork.
              log.warn("failed to register forked turn stream", {
                forkSessionId: message.sessionId,
                forkTurnId: message.turnId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
        if (recorder) {
          await recordAgentTraceBestEffort(recorder, message, log, {
            turnId: forkTurnId ?? "unknown",
            source: "agent-runner:fork",
          });
        }
        liveStream?.publish(message);
        yield message;
      }
    } finally {
      liveStream?.finish();
    }

    log.info("forked agent run completed", {
      agent: params.agentName,
      sourceSessionId: params.sourceSessionId,
      forkTurnId,
    });
  }

  /**
   * Register the fork's rome session (with parent lineage) and return a
   * recorder targeting it. Best-effort: a persistence failure must not break
   * the forked run, so any error degrades to "no recording" with a warning.
   */
  private async createForkTraceRecorder(
    params: ForkRunParams,
    turnStart: Extract<AgentMessage, { type: "turn_start" }>,
    sourceRomeSessionId?: string,
  ): Promise<AgentTraceRecorder | null> {
    if (!this.webchatRepo) return null;
    try {
      const thread = params.threadContext;
      // Prefer the source's persisted conversation binding. The fallbacks
      // cover older/non-conversation callers that did not acquire with one.
      const parentSessionId =
        sourceRomeSessionId ??
        (thread?.channel === "webchat"
          ? thread.threadId
          : thread
            ? `channel:${thread.channel}:${thread.threadId}`
            : null);
      const parent = parentSessionId ? await this.webchatRepo.getSession(parentSessionId) : null;
      const parentName = parent?.name ?? thread?.threadName ?? params.sourceSessionId;
      const label = params.label ?? "fork";
      const trigger = { triggerKind: "fork", triggerName: label };
      await this.webchatRepo.ensureRomeSession({
        id: turnStart.sessionId,
        type: "fork",
        name: `${label}: ${parentName}`,
        agentName: isCoreMainAgentId(params.agentName) ? null : params.agentName,
        projectName: thread?.projectName,
        projectPath: thread?.projectPath,
        sourceChannel: thread?.channel ?? null,
        sourceThreadId: thread?.threadId ?? null,
        sourceThreadName: thread?.threadName ?? null,
        sourceThreadType: thread?.threadType ?? null,
        trigger,
        parentSessionId: parent ? parentSessionId : null,
        parentTurnId: parent ? (params.parentTurnId ?? null) : null,
      });
      return new AgentTraceRecorder({
        webchatRepo: this.webchatRepo,
        agentName: params.agentName,
        channelThreadKey: params.channelThreadKey,
        turnId: turnStart.turnId,
        existingSessionId: turnStart.sessionId,
        threadContext: params.threadContext,
        persistTranscript: true,
        trigger,
      });
    } catch (err) {
      log.warn("failed to register forked run session; skipping trace persistence", {
        agent: params.agentName,
        sourceSessionId: params.sourceSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
