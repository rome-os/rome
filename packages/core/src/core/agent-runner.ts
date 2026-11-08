import { DEFAULT_REASONING_EFFORT } from "@rome-os/app-runtime";
import type { AgentEvent, McpServerConfig } from "../types.js";
import type { ActionRegistry } from "../actions/types.js";
import type {
  ModelReasoningEffort,
  ModelSession,
  ModelSessionParams,
  ModelToolCallContext,
  RomeToolDefinition,
  ModelUserInput,
  ProviderId,
  RomeTools,
  ThreadStart,
} from "../agent/index.js";
import { type ForkRunParams, type RunParams, type ThreadContext } from "./types.js";
import type { AgentSession, AgentSessionManager } from "./agent-session.js";
import type { AgentCatalog } from "../agent/index.js";
import { createLogger } from "../logger.js";
import { type ChatResetPolicy, resetPolicyOfMessage } from "./chat-reset-policy.js";
import type { SessionOpeningFor } from "./session-opening.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { channelChatId } from "../db/session-kind.js";
import type { AgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import {
  AgentTraceRecorder,
  recordAgentTraceBestEffort,
  resolveTurnConversation,
  shouldPersistAgentTrace,
} from "./agent-trace-recorder.js";
import { findChat, findSessionChat, openedInChat, openerChat } from "./session-conversation.js";
import { isCoreMainAgentId } from "../apps/artifact-id.js";
import { adhocSessionKey } from "./agent-session-key.js";
import { runLines, type RunLineDeps } from "../connections/speaker-messages.js";

const log = createLogger("agent-runner");

import type { ModelSessionEvent } from "../agent/index.js";

// The model provider port lives in the agent context; these re-exports keep
// today's importers compiling until they import it from there.
export type {
  ProviderId,
  ModelTier,
  RomeToolDefinition,
  ModelToolCallContext,
  ModelReasoningEffort,
  ModelProvider,
  ModelSessionParams,
  ModelUserInput,
  ModelSession,
  ThreadStart,
} from "../agent/index.js";

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
  /** The Rome tools the session serves; a mock calls them as a provider would. */
  tools: RomeTools;
  outputSchema?: Record<string, unknown>;
  builtinTools?: string[];
  maxTurns?: number;
  reasoningEffort?: ModelReasoningEffort;
  thread: ThreadStart;
  workingDir?: string;
  externalMcpServers?: Record<string, McpServerConfig>;
}

/**
 * Synthesize a `ModelSession` from a legacy one-turn `run` callback.
 * Used by mock providers (and any test harness) that don't own a real
 * long-lived SDK Query: each `sendUserInput` consumes one `run()` invocation
 * and drains its messages into the session's events stream.
 */
export function createSessionFromRun(
  providerId: ProviderId,
  run: (params: ModelRunParams) => AsyncIterable<AgentEvent | ModelSessionEvent>,
  params: ModelSessionParams,
): ModelSession {
  if (params.thread.kind === "branch") {
    throw new Error("Branching a thread is not supported by this provider");
  }
  // Standard async-queue: emit() either hands the value to a waiting
  // consumer (resolvers FIFO) or buffers it for the next next() call. Don't
  // share a single `pending` slot — back-to-back emits would clobber each
  // other since the consumer hasn't had a chance to await again yet.
  const buffer: ModelSessionEvent[] = [];
  const resolvers: Array<(item: IteratorResult<ModelSessionEvent>) => void> = [];
  let closed = false;

  const emit = (msg: ModelSessionEvent) => {
    if (closed) return;
    if (resolvers.length > 0) {
      const r = resolvers.shift()!;
      r({ value: msg, done: false });
    } else {
      buffer.push(msg);
    }
  };

  const events: AsyncIterable<ModelSessionEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<ModelSessionEvent>> {
          if (buffer.length > 0) {
            return { value: buffer.shift()!, done: false };
          }
          if (closed) return { value: undefined as never, done: true };
          return await new Promise<IteratorResult<ModelSessionEvent>>((resolve) => {
            resolvers.push(resolve);
          });
        },
      };
    },
  };

  return {
    providerId,
    model: params.config.model,
    events,
    async sendUserInput(input: ModelUserInput): Promise<void> {
      // ModelRunParams is a per-turn snapshot for legacy `run()`-based mock
      // providers — call the getters here so each turn sees the current view.
      const { config } = params;
      const runParams: ModelRunParams = {
        model: config.model,
        systemPrompt: config.systemPrompt,
        prompt: input.text,
        tools: params.tools,
        outputSchema: config.outputSchema,
        builtinTools: config.builtinTools,
        maxTurns: config.maxTurns,
        reasoningEffort: input.reasoningEffort ?? config.reasoningEffort,
        thread: params.thread,
        workingDir: config.workingDir,
        externalMcpServers: config.externalMcpServers,
      };
      const { reasoningEffort } = runParams;
      for await (const msg of run(runParams)) {
        emit(
          msg.type === "result"
            ? { reasoningEffort: reasoningEffort ?? DEFAULT_REASONING_EFFORT, ...msg }
            : msg,
        );
      }
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
 * fallback error rather than hanging, so the session never wedges.
 */
export function createNullModelSession(params: ModelSessionParams): ModelSession {
  const buffer: ModelSessionEvent[] = [];
  const resolvers: Array<(item: IteratorResult<ModelSessionEvent>) => void> = [];
  let closed = false;

  const emit = (msg: ModelSessionEvent) => {
    if (closed) return;
    if (resolvers.length > 0) {
      resolvers.shift()!({ value: msg, done: false });
    } else {
      buffer.push(msg);
    }
  };

  const events: AsyncIterable<ModelSessionEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<ModelSessionEvent>> {
          if (buffer.length > 0) return { value: buffer.shift()!, done: false };
          if (closed) return { value: undefined as never, done: true };
          return await new Promise<IteratorResult<ModelSessionEvent>>((resolve) => {
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
    model: params.config.model,
    events,
    async sendUserInput(): Promise<void> {
      emit({ type: "text", content: FALLBACK });
      emit({ type: "error", error: "No handler took this turn" });
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
    private agentLoader: AgentCatalog,
    private webchatRepo?: WebChatRepository,
    private turnStreams?: AgentTurnStreamRegistry,
    private actionRegistry?: Pick<ActionRegistry, "getForAgent" | "getCanonicalName">,
    /** Chats' lines a run names by the platform's ids. Given, a recorded
     *  prompt becomes its turn's through Chats' turn links, not
     *  `webchatRepo`'s rows. */
    private runLineDeps?: RunLineDeps,
    /** The reset policy of a connected account's chat. Absent, no session is reset. */
    private resetPolicyOf?: ChatResetPolicy,
    /** What this opener states for a session it opens. Absent, it states nothing. */
    private sessionOpeningFor?: SessionOpeningFor,
  ) {}

  /**
   * Returns true when the named agent is loaded in the catalog. Lets callers
   * (e.g. the inbox message handler) gracefully fall back when a channel is
   * configured to route to an agent that has been uninstalled.
   */
  hasAgent(name: string): boolean {
    return this.agentLoader.find(name) !== undefined;
  }

  /**
   * Returns true when the named agent may call the named action, through the
   * same `getForAgent` resolution the agent session uses for its tool catalog
   * and execution gate. Unknown agent or action → false.
   */
  hasAction(agentName: string, actionName: string): boolean {
    if (!this.actionRegistry) return false;
    const agent = this.agentLoader.find(agentName);
    if (!agent) return false;
    const actions = agent.definition.actions ?? [];
    const canonical = this.actionRegistry.getCanonicalName?.(actionName) ?? actionName;
    return this.actionRegistry
      .getForAgent(actions)
      .some((action) => action.config.name === canonical);
  }

  async *run(params: RunParams): AsyncIterable<AgentEvent> {
    // Synthetic key for keyless invocations (e.g. ad-hoc envoy validation
    // runs). Real conversations always pass a `channelThreadKey`.
    const requestedChannelThreadKey = params.channelThreadKey ?? adhocSessionKey(params.agentName);
    const explicitSessionId = params.sessionId;

    log.info("agent run started", {
      agent: params.agentName,
      channelThreadKey: explicitSessionId ? undefined : requestedChannelThreadKey,
      sessionId: params.sessionId,
      promptPreview: params.prompt.slice(0, 200),
    });

    const threadContext = await this.withChatId(params.threadContext);
    const openedKey = explicitSessionId
      ? await this.webchatRepo?.continuityKeyOfSession(explicitSessionId)
      : requestedChannelThreadKey;
    const init = {
      ...(openedKey ? this.sessionOpeningFor?.(openedKey, threadContext) : {}),
      workingDir: params.workingDir,
      threadContext,
      sharedContext: params.sharedContext,
      contextSuffix: params.contextSuffix,
      resetPolicy: await resetPolicyOfMessage(this.resetPolicyOf, {
        platformMessageId: params.platformMessageId,
        sessionId: explicitSessionId,
        threadContext,
      }),
    };
    const session = explicitSessionId
      ? await this.agentSessionManager.acquireBySessionId(explicitSessionId, params.agentName, init)
      : await this.agentSessionManager.acquire(
          { agentName: params.agentName, channelThreadKey: requestedChannelThreadKey },
          init,
        );
    await openedInChat(this.webchatRepo, session, params.romeSessionId);
    const agentName = session.key.agentName;
    // An explicit sessionId is the source of truth for continuations. Use the
    // canonical key returned by the session row rather than requiring callers
    // to carry a duplicate channelThreadKey that can drift from it.
    const channelThreadKey = session.key.channelThreadKey;

    const opened = openerChat(session);
    const conversation = resolveTurnConversation({
      agentName,
      agentSessionId: session.sessionId,
      romeSessionId: params.romeSessionId,
      openerChat: opened,
      sessionChat:
        (opened ?? params.romeSessionId)
          ? undefined
          : await findSessionChat(this.webchatRepo, session.sessionId),
      channelThreadKey,
      threadContext,
    });
    const { romeSessionId, romeSessionType } = conversation;
    // The line the run names by its platform id, which the turn answers, and
    // the one its reply quotes, as Chats holds them.
    const lines = this.runLineDeps
      ? await runLines(this.runLineDeps.lines, romeSessionId, params)
      : null;

    // sendTurn is sync — turnId is allocated by AgentSession
    // and surfaced on the stream's turn_start event.
    const handle = session.sendTurn(
      { prompt: params.prompt, images: params.images },
      {
        threadContext,
        sharedContext: params.sharedContext,
        romeSessionId,
        romeSessionType,
        replyTo: params.replyTo,
        ...(lines ? { quoted: lines.quoted } : {}),
        initiatedBy: params.initiatedBy ?? "user",
        ...(params.pushLevel ? { pushLevel: params.pushLevel } : {}),
      },
    );
    this.runLineDeps?.replies?.runs(handle.turnId, agentName);
    if (lines && this.runLineDeps) {
      if (conversation.promptPersisted && lines.prompt !== null) {
        this.runLineDeps.links.prompt(lines.prompt, romeSessionId, handle.turnId);
      }
    } else if (this.webchatRepo && conversation.promptPersisted && params.platformMessageId) {
      await this.webchatRepo.assignConversationMessageTurn(
        romeSessionId,
        params.platformMessageId,
        handle.turnId,
      );
    }

    const persistTrace = params.persistTrace ?? shouldPersistAgentTrace(threadContext);
    const recorder =
      this.webchatRepo && persistTrace
        ? new AgentTraceRecorder({
            webchatRepo: this.webchatRepo,
            agentName,
            agentSessionId: session.sessionId,
            romeSessionId,
            existingSessionId: conversation.existing ? romeSessionId : undefined,
            channelThreadKey,
            turnId: handle.turnId,
            threadContext,
            // A recorder-owned conversation has no other transcript, whatever
            // the caller's channel keeps.
            persistTranscript: conversation.recorderOwned || (params.persistTranscript ?? true),
            persistUserTranscript: !conversation.promptPersisted,
            persistAssistantTranscript:
              conversation.recorderOwned || (params.persistAnswer ?? true),
          })
        : null;

    for await (const msg of handle.events) {
      if (recorder) {
        await recordAgentTraceBestEffort(recorder, msg, log, {
          turnId: handle.turnId,
          source: "agent-runner",
        });
        // The turn's input, under the caller's label, right after it starts.
        if (msg.type === "turn_start" && params.inputLabel) {
          await recorder
            .recordSystemInput(params.inputLabel, params.prompt)
            .catch((error: unknown) =>
              log.warn("system input not recorded", {
                turnId: handle.turnId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
        }
      }
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
    let forkSessionId: string | undefined;
    let liveStream: ReturnType<AgentTurnStreamRegistry["register"]> | null = null;
    try {
      for await (const message of source.runForkedTurn({
        prompt: params.prompt,
        tier: params.tier,
        mode: params.mode,
        sourceCheckpoint: params.sourceCheckpoint,
        threadContext: params.threadContext,
        persistThreadKey: params.persistThreadKey,
      })) {
        if (!forkTurnId && message.type === "turn_start") {
          forkTurnId = message.turnId;
          forkSessionId = message.sessionId;
          recorder = await this.createForkTraceRecorder(params, message, source);
          if (this.turnStreams) {
            try {
              // Forks have their own session and trace, so publish them through
              // the same late-attach registry as Child turns. They deliberately
              // omit `interrupt`: AgentSession cannot currently stop one fork
              // without risking the source session that owns it.
              liveStream = this.turnStreams.register({
                sessionId: message.sessionId,
                // The fork is a chat of its own once its row is saved; one
                // whose row could not be saved is open to no one.
                chatId: message.sessionId,
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
      // A continuable fork's session is stored once its turn ends, also when
      // the consumer stops early, and its chat is minted under the fork's own
      // id. Nothing is stored for a one-shot fork.
      if (forkSessionId && this.webchatRepo) {
        try {
          await this.webchatRepo.recordSessionInChat(forkSessionId, forkSessionId);
        } catch (err) {
          log.warn("failed to record the chat that has the fork's session", {
            forkSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    log.info("forked agent run completed", {
      agent: params.agentName,
      sourceSessionId: params.sourceSessionId,
      forkTurnId,
    });
  }

  /**
   * Register the fork's rome session and return a recorder targeting it. A
   * fork of a chat is that chat's child: it is saved with its parent's owner
   * and privacy, and when the chat is gone or the row cannot be saved this
   * throws, so the fork does not run. A fork that names no chat is
   * best-effort: a persistence failure degrades to "no recording".
   */
  private async createForkTraceRecorder(
    params: ForkRunParams,
    turnStart: Extract<AgentEvent, { type: "turn_start" }>,
    source: AgentSession,
  ): Promise<AgentTraceRecorder | null> {
    if (!this.webchatRepo) return null;
    const thread = params.threadContext;
    // Prefer the source's chat while it exists: the one its opener named, else
    // the chat that has the source session.
    const opened = openerChat(source);
    const recorded = opened
      ? await findChat(this.webchatRepo, opened)
      : await findSessionChat(this.webchatRepo, source.sessionId);
    // The chat the fork is of, when the turn names one.
    const named = recorded?.id ?? thread?.romeSessionId;
    // A channel thread that recorded no conversation may still have its row.
    const fallback = thread ? channelChatId(thread.channel, thread.threadId) : null;
    const parentSessionId =
      named ?? (fallback && (await this.webchatRepo.getSession(fallback)) ? fallback : null);
    const parent =
      recorded ?? (parentSessionId ? await this.webchatRepo.getSession(parentSessionId) : null);
    if (named && !parent) throw new Error(`Parent Rome session "${named}" was not found`);
    const parentName = parent?.name ?? thread?.threadName ?? params.sourceSessionId;
    const label = params.label ?? "fork";
    const trigger = { triggerKind: "fork", triggerName: label };
    const save = async () => {
      await this.webchatRepo!.ensureRomeSession({
        id: turnStart.sessionId,
        type: "fork",
        name: `${label}: ${parentName}`,
        agentName: isCoreMainAgentId(params.agentName) ? null : params.agentName,
        projectName: thread?.projectName,
        projectPath: thread?.projectPath,
        // Later turns of the side chat read the folder from this row.
        deviceFolder: thread?.deviceFolder ?? null,
        trigger,
        parentSessionId,
        parentTurnId: parentSessionId ? (params.parentTurnId ?? null) : null,
      });
      return new AgentTraceRecorder({
        webchatRepo: this.webchatRepo!,
        agentName: params.agentName,
        channelThreadKey: params.channelThreadKey,
        turnId: turnStart.turnId,
        existingSessionId: turnStart.sessionId,
        threadContext: params.threadContext,
        persistTranscript: true,
        trigger,
      });
    };
    // A child must be saved with its parent's owner, or not run at all.
    if (parentSessionId) return save();
    try {
      return await save();
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
