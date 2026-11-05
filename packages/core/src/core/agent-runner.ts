import type { AgentEvent, McpServerConfig, ReasoningEffort } from "../types.js";
import type { ActionConfig, ActionRegistry } from "../actions/types.js";
import type { DeferInput } from "./defer.js";
import type { FacadeToolDef, RoutineActivationGate } from "./mcp-facade.js";
import type { UsageFunding } from "../usage/events.js";
import { type ForkRunParams, type RunParams, type ThreadContext } from "./types.js";
import type { AgentSessionManager } from "../agent-sessions/index.js";
import type { AgentLoader } from "./agent-loader.js";
import { createLogger } from "../logger.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { channelChatId } from "../db/session-kind.js";
import type { AgentTurnStreamRegistry } from "../agent-sessions/index.js";
import { linkPromptToTurn, runLines, type RunLineDeps } from "../connections/speaker-messages.js";
import {
  sessionSurfaceOf,
  surfaceKeepsTurn,
  type SurfaceDeps,
} from "../connections/session-surface.js";
import {
  callerChatId,
  callerFromKey,
  callerKey,
  callerOfRun,
  type SessionCaller,
} from "./session-caller.js";
import { catchUpBriefing, type CatchUpDeps } from "./connection-briefing.js";
import { resetWhenDue, type ResolveConnectionReset } from "./connection-reset.js";
import { rememberedChatModel } from "./chat-model-selection.js";
import { openNamed } from "../agent-sessions/index.js";

/** What a wake on a connection adds to a run: the catch-up it briefs the
 *  agent with, the reset setting it applies first, and what the run's
 *  surface can show. */
export interface WakeDeps {
  catchUp?: CatchUpDeps;
  resolveReset?: ResolveConnectionReset;
  surface?: SurfaceDeps;
}

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

// One definition, owned by the skill catalog that produces it.
import type { SkillMcpDefinition } from "./skill-catalog.js";
export type { SkillMcpDefinition };

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

/**
 * Synthesize a `ModelSession` from a legacy one-turn `run` callback.
 * Used by mock providers (and any test harness) that don't own a real
 * long-lived SDK Query: each `sendUserInput` consumes one `run()` invocation
 * and drains its messages into the session's events stream.
 */
export function createSessionFromRun(
  providerId: ProviderId,
  run: (params: ModelRunParams) => AsyncIterable<AgentEvent>,
  params: ModelSessionParams,
): ModelSession {
  // Standard async-queue: emit() either hands the value to a waiting
  // consumer (resolvers FIFO) or buffers it for the next next() call. Don't
  // share a single `pending` slot — back-to-back emits would clobber each
  // other since the consumer hasn't had a chance to await again yet.
  const buffer: AgentEvent[] = [];
  const resolvers: Array<(item: IteratorResult<AgentEvent>) => void> = [];
  let closed = false;

  const emit = (msg: AgentEvent) => {
    if (closed) return;
    if (resolvers.length > 0) {
      const r = resolvers.shift()!;
      r({ value: msg, done: false });
    } else {
      buffer.push(msg);
    }
  };

  const events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<AgentEvent>> {
          if (buffer.length > 0) {
            return { value: buffer.shift()!, done: false };
          }
          if (closed) return { value: undefined as never, done: true };
          return await new Promise<IteratorResult<AgentEvent>>((resolve) => {
            resolvers.push(resolve);
          });
        },
      };
    },
  };

  let appliedReasoningEffort: string | undefined;

  return {
    providerId,
    model: params.model,
    events,
    get appliedReasoningEffort(): string | undefined {
      return appliedReasoningEffort;
    },
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
        builtinTools: params.builtinTools,
        maxTurns: params.maxTurns,
        reasoningEffort: input.reasoningEffort ?? params.reasoningEffort,
        sessionId: params.sessionId,
        isNewSession: params.isNewSession,
        workingDir: params.workingDir,
        externalMcpServers: params.externalMcpServers,
        executeAction: params.executeAction,
        executeSubagent: params.executeSubagent,
      };
      appliedReasoningEffort = runParams.reasoningEffort;
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
  const buffer: AgentEvent[] = [];
  const resolvers: Array<(item: IteratorResult<AgentEvent>) => void> = [];
  let closed = false;

  const emit = (msg: AgentEvent) => {
    if (closed) return;
    if (resolvers.length > 0) {
      resolvers.shift()!({ value: msg, done: false });
    } else {
      buffer.push(msg);
    }
  };

  const events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<AgentEvent>> {
          if (buffer.length > 0) return { value: buffer.shift()!, done: false };
          if (closed) return { value: undefined as never, done: true };
          return await new Promise<IteratorResult<AgentEvent>>((resolve) => {
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
    private agentLoader: AgentLoader,
    private webchatRepo?: WebChatRepository,
    private turnStreams?: AgentTurnStreamRegistry,
    private actionRegistry?: Pick<ActionRegistry, "getForAgent" | "getCanonicalName">,
    /** Chats' lines a run names by the platform's ids. Given, a recorded
     *  prompt becomes its turn's through Chats' turn links, not
     *  `webchatRepo`'s rows. */
    private runLineDeps?: RunLineDeps,
    private wake?: WakeDeps,
  ) {}

  /**
   * Returns true when the named agent is loaded in the catalog. Lets callers
   * (e.g. the inbox message handler) gracefully fall back when a channel is
   * configured to route to an agent that has been uninstalled.
   */
  hasAgent(name: string): boolean {
    return this.agentLoader.has(name);
  }

  /**
   * Returns true when the named agent may call the named action, through the
   * same `getForAgent` resolution the agent session uses for its tool catalog
   * and execution gate. Unknown agent or action → false.
   */
  hasAction(agentName: string, actionName: string): boolean {
    if (!this.actionRegistry) return false;
    let actions: string[];
    try {
      actions = this.agentLoader.getRecord(agentName).config.actions ?? [];
    } catch {
      return false;
    }
    const canonical = this.actionRegistry.getCanonicalName?.(actionName) ?? actionName;
    return this.actionRegistry
      .getForAgent(actions)
      .some((action) => action.config.name === canonical);
  }

  async *run(params: RunParams): AsyncIterable<AgentEvent> {
    const explicitSessionId = params.sessionId;

    log.info("agent run started", {
      agent: params.agentName,
      caller: explicitSessionId ? undefined : params.caller,
      channelThreadKey: explicitSessionId ? undefined : params.channelThreadKey,
      sessionId: params.sessionId,
      promptPreview: params.prompt.slice(0, 200),
    });

    // The caller that names this run, as the caller's side holds it. A resume
    // by id may name it too, which its surface reads.
    const named =
      params.caller ??
      (params.channelThreadKey ? callerFromKey(params.channelThreadKey) : undefined);
    const caller = explicitSessionId
      ? named
      : (params.caller ??
        callerOfRun(params.agentName, params.channelThreadKey, params.romeSessionId));
    // The conversation the run names, where Chats keeps its lines.
    const chatId = explicitSessionId ? undefined : caller && callerChatId(caller);
    const threadContext = await this.withChatId(params.threadContext);
    const persistTranscript = params.persistTranscript ?? true;
    const surface = sessionSurfaceOf(this.wake?.surface ?? {}, caller, threadContext, {
      ...(params.contextSuffix ? { about: params.contextSuffix } : {}),
      keeps: {
        // A run that names a conversation it does not reply into keeps its
        // own record there, and the session's log stays out of it.
        turn:
          params.persistTrace === undefined
            ? surfaceKeepsTurn(threadContext)
            : !params.persistTrace,
        prompt: !persistTranscript,
        answer: !persistTranscript || !(params.persistAnswer ?? true),
      },
    });
    const options = {
      workingDir: params.workingDir,
      ...(explicitSessionId
        ? {
            model: await rememberedChatModel(
              { webchatRepo: this.webchatRepo, sessions: this.agentSessionManager },
              {
                agentName: params.agentName,
                sessionId: explicitSessionId,
                caller: named,
                replies: threadContext,
              },
            ),
          }
        : {}),
    };
    let session;
    if (explicitSessionId) {
      session = await this.agentSessionManager.session(
        explicitSessionId,
        params.agentName,
        surface,
        options,
      );
    } else {
      // A run that names no conversation gets a caller of its own.
      const runCaller = caller!;
      // A wake by a message on a connection applies the place's reset setting.
      if (params.platformMessageId) {
        await resetWhenDue(
          this.agentSessionManager,
          this.wake?.resolveReset,
          params.agentName,
          runCaller,
          threadContext,
        );
      }
      const runCallerId = callerKey(runCaller);
      session = await openNamed(runCallerId, chatId, () =>
        this.agentSessionManager.open(params.agentName, runCallerId, surface, options),
      );
    }
    const agentName = session.key.agentName;
    // Where Chats keeps the run's lines: the conversation the run names, else
    // the one its reply address does.
    const romeSessionId =
      chatId ??
      threadContext?.romeSessionId ??
      (threadContext ? channelChatId(threadContext.channel, threadContext.threadId) : undefined);
    // The line the run names by its platform id, which the turn answers, and
    // the one its reply quotes, as Chats holds them.
    const lines =
      this.runLineDeps && romeSessionId
        ? await runLines(this.runLineDeps.lines, romeSessionId, params)
        : null;

    // sendTurn is sync — turnId is allocated by AgentSession
    // and surfaced on the stream's turn_start event.
    const briefing = catchUpBriefing(this.wake?.catchUp ?? {}, {
      threadContext,
      ...(romeSessionId ? { romeSessionId } : {}),
      replyTo: params.replyTo,
      quoted: lines?.quoted ?? null,
    });
    const handle = session.sendTurn(
      {
        prompt: params.prompt,
        images: params.images,
        ...(params.sharedContext ? { sharedContext: params.sharedContext } : {}),
        ...(params.inputLabel ? { label: params.inputLabel } : {}),
      },
      {
        ...(briefing ? { briefing } : {}),
        initiatedBy: params.initiatedBy ?? "user",
      },
    );
    this.runLineDeps?.replies?.runs(handle.turnId, agentName);
    // Chats wrote the prompt of a run that names its conversation.
    if (chatId) {
      await linkPromptToTurn(
        { webchatRepo: this.webchatRepo, runLineDeps: this.runLineDeps },
        {
          romeSessionId: chatId,
          turnId: handle.turnId,
          lines,
          platformMessageId: params.platformMessageId,
        },
      );
    }

    for await (const msg of handle.events) {
      yield msg;
    }

    log.info("agent run completed", {
      agent: agentName,
      sessionId: session.sessionId,
    });
  }

  /**
   * The thread context with its conversation id filled in from the address
   * when the caller left it out. Re-entries such as backend turns and approval
   * resumes carry only the channel address, and an approval saved before
   * callers set the id carries no id at all.
   */
  private async withChatId(
    threadContext: ThreadContext | undefined,
  ): Promise<ThreadContext | undefined> {
    if (!threadContext || threadContext.romeSessionId || !this.webchatRepo) return threadContext;
    const romeSessionId = await this.webchatRepo.findChatIdByAddress(
      threadContext.channel,
      threadContext.threadId,
    );
    return romeSessionId ? { ...threadContext, romeSessionId } : threadContext;
  }

  async *runForked(params: ForkRunParams): AsyncIterable<AgentEvent> {
    const caller =
      params.caller ?? (params.channelThreadKey ? callerFromKey(params.channelThreadKey) : null);
    if (!caller) throw new Error("Cannot fork agent session without the source session's caller");
    const source = this.agentSessionManager.live(params.agentName, callerKey(caller));
    if (!source) {
      throw new Error("Cannot fork agent session because the source session is not live");
    }
    if (source.sessionId !== params.sourceSessionId) {
      throw new Error("Cannot fork agent session because the source session id does not match");
    }

    log.info("forked agent run started", {
      agent: params.agentName,
      sourceSessionId: params.sourceSessionId,
      caller,
      mode: params.mode ?? "isolated",
      promptPreview: params.prompt.slice(0, 200),
    });

    // A fork keeps its own record, under its source's: the session registers
    // it once the fork's ids are known.
    let forkTurnId: string | undefined;
    let liveStream: ReturnType<AgentTurnStreamRegistry["register"]> | null = null;
    const continueAs = params.continueAs;
    try {
      for await (const message of source.runForkedTurn({
        prompt: params.prompt,
        tier: params.tier,
        mode: params.mode,
        sourceCheckpoint: params.sourceCheckpoint,
        atTurn: params.atTurn,
        threadContext: params.threadContext,
        ...(continueAs ? { continueAs: (id: string) => callerKey(continueAs(id)) } : {}),
        label: params.label,
        parentTurnId: params.parentTurnId,
      })) {
        if (!forkTurnId && message.type === "turn_start") {
          forkTurnId = message.turnId;
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
}
