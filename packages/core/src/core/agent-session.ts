// Long-lived, serialized agent sessions. Session model: docs/concepts/sessions.md.

import { createHash } from "node:crypto";
import { Mutex } from "async-mutex";
import {
  AgentInputQueue,
  type AgentInputReceipt,
  type SubmitInputOptions,
} from "./agent-input-queue.js";
import { v4 as uuidv4 } from "uuid";
import type { AgentLoader } from "./agent-loader.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { SessionManager } from "./session-manager.js";
import { getChannelFromThreadKey } from "./session-manager.js";
import {
  buildInteractiveSurfaceGuidanceSection,
  buildThreadContextBlock,
  type PromptBuilder,
} from "./prompt-builder.js";
import type { ActionRegistry, Action } from "../actions/types.js";
import type { ActionEngine } from "../actions/engine.js";
import type { CapabilityDiscovery } from "./capability-discovery.js";
import type { SkillCatalog } from "./skill-catalog.js";
import type { AgentMessage, AgentSession as DbAgentSession, McpServerConfig } from "../types.js";
import type {
  AgentTurnOutput,
  AgentTurnStatus,
  ErrorMessage,
  MessageReplyReference,
  ResultMessage,
  RomeSessionRef,
  RomeSessionType,
  StreamAgentMessage,
  TurnMiddlewareContext,
  ConversationId,
  ConversationRef,
  ProviderSessionResetPolicy,
} from "@rome-os/app-runtime";
import { createNullModelSession } from "./agent-runner.js";
import { runDefer, type DeferInput } from "./defer.js";
import type {
  ActionMcpDefinition,
  ModelSession,
  ModelSessionForkOpenParams,
  ModelSessionParams,
  ModelReasoningEffort,
  ModelTier,
  ModelToolDefinition,
  ModelToolCallContext,
  ProviderId,
  SkillMcpDefinition,
} from "./agent-runner.js";
import {
  toModelResolutionErrorPayload,
  type ModelResolution,
  type ModelResolutionErrorPayload,
  type ModelResolver,
} from "./model-resolver.js";
import {
  resolveWebchatLargeModelSelection,
  type ModelSelectionId,
  type WebchatLargeModelSelection,
} from "./model-selector.js";
import { type ForkRunMode, type ForkSourceCheckpoint, type ThreadContext } from "./types.js";
import { createLogger } from "../logger.js";
import { ensureDefaultAgentWorkingDir } from "../paths.js";
import { enterSession } from "../telemetry-context.js";
import {
  getTracer,
  modelPromptCacheMetric,
  modelSessionOpenMetric,
  modelTurnTtftMetric,
  sessionAcquireMetric,
  sessionDurationMetric,
  startRomeSpan,
  withRomeSpan,
} from "../telemetry.js";
import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span,
} from "@opentelemetry/api";
import { isTerminalBlock } from "./agent-message.js";
import type { ActiveSubagentRegistry, ParentSubagentRef } from "./active-subagent-registry.js";
import type {
  ExecuteSubagentInput,
  SubagentExecution,
  SubagentExecutionService,
} from "./subagent-execution.js";
import {
  compileJsonSchema,
  compileOutputSchema,
  formatOutputSchemaErrors,
  type CompiledOutputSchema,
} from "../apps/packaging/output-schema-validator.js";
import { translateTurnSpans, type CapturedBlock } from "./turn-span-translator.js";
import {
  buildRequiredTiming,
  classifyAgentTurnStatus,
  createAgentTurnRef,
  type AgentLifecycleDispatcher,
  type AgentTurnParentRef,
} from "./agent-lifecycle.js";
import type { TurnMiddlewareChain } from "./turn-middleware.js";
import { isGuardianFacingChannel } from "./guardian-channel.js";
import type {
  StoredConversationContextMessage,
  WebChatRepository,
} from "../db/repositories/webchat.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import { evaluateProviderSessionReset } from "../conversation-settings/reset-policy.js";

const log = createLogger("agent-session");

function conversationMessageText(content: string): string {
  try {
    const parts = JSON.parse(content) as unknown;
    if (!Array.isArray(parts)) return content;
    return parts
      .flatMap((part) =>
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "content" in part &&
        typeof part.content === "string"
          ? [part.content]
          : [],
      )
      .join("\n");
  } catch {
    return content;
  }
}

type ConversationContextMessage = Omit<StoredConversationContextMessage, "createdAt"> & {
  createdAt?: Date;
};

function conversationContextLine(message: ConversationContextMessage): string {
  const sender = message.senderName?.trim() || "Unknown sender";
  const timestamp = message.createdAt ? `[${message.createdAt.toISOString()}] ` : "";
  return `${timestamp}${sender}: ${conversationMessageText(message.content)}`;
}

function prependConversationContext(
  prompt: string,
  context: {
    notifications: StoredConversationContextMessage[];
    omittedNotificationCount: number;
    repliedTo: ConversationContextMessage | null;
  },
): string {
  const sections: string[] = [];
  const notifications = context.repliedTo
    ? context.notifications.filter((message) => message.id !== context.repliedTo?.id)
    : context.notifications;
  if (notifications.length > 0 || context.omittedNotificationCount > 0) {
    sections.push(
      "<conversation_context>",
      ...(context.omittedNotificationCount > 0
        ? [`[${context.omittedNotificationCount} earlier messages omitted]`]
        : []),
      ...notifications.map(conversationContextLine),
      "</conversation_context>",
    );
  }
  if (context.repliedTo) {
    sections.push(
      "<reply_context>",
      conversationContextLine(context.repliedTo),
      "</reply_context>",
    );
  }
  if (sections.length === 0) return prompt;
  sections.push("<current_message>", prompt, "</current_message>");
  return sections.join("\n");
}

export interface AgentSessionKey {
  agentName: string;
  /** e.g. `webchat:<id>`, `telegram:<chatId>`, `sentinel:<channel>:<thread>`. */
  channelThreadKey: string;
}

export interface AgentSessionInit {
  workingDir?: string;
  threadContext?: ThreadContext;
  /** Stable Rome conversation bound to this provider/runtime session. */
  romeSessionId?: string;
  sharedContext?: Record<string, unknown>;
  forceNewSession?: boolean;
  /**
   * Set by `AgentSessionBridge` for runs that reach the top-level manager over
   * the worker→main RPC — i.e. an action spawning an agent (blocking `summon`),
   * which is a nested subagent run by construction. Used only for the
   * `rome.session.acquire` metric's `is_subagent` label; it does NOT change
   * session behavior (login-notice gating, defer, etc. still key off the
   * manager-level `isSubagent`, which is false for the top-level manager).
   */
  isSubagent?: boolean;
  /** Explicit runtime session id to resume. */
  resumeSessionId?: string;
  /** Appended to the system prompt at open time. */
  contextSuffix?: string;
  /** Optional exact model selection, used by the WebChat model selector. */
  selectionId?: ModelSelectionId;
  reasoningEffort?: ModelReasoningEffort;
  /** Existing inbound platform message id, when this acquire starts its turn. */
  platformMessageId?: string;
  /**
   * Session-scoped handback contract for a handoff child conversation
   * (handoff + interactive summon). Exposes the `submit_output` tool validated
   * against `schema` on every turn, WITHOUT the per-turn fail-closed rule that
   * agent-declared `outputSchema` carries — turns may end freely; a submission
   * is the conversation's candidate handback, not the turn's required
   * terminal. `validate` optionally names an action the host runs on each
   * schema-valid submission for app-specific semantic checks (fail-closed).
   * It cannot be combined with an agent-declared `outputSchema`.
   */
  handback?: { schema: Record<string, unknown>; validate?: string };
  /** Runtime-internal id for a generation already created transactionally. */
  preparedSessionId?: string;
}

export interface AgentTurnInput {
  inputId?: string;
  prompt: string;
  /** Absolute local paths of images attached to the turn (providers without image-input support ignore them). */
  images?: string[];
  reasoningEffort?: ModelReasoningEffort;
  /** Optional injected tool-result, for approval continuations. */
  injectedToolResult?: { toolUseId: string; content: unknown };
}

export interface ForkedAgentTurnInput extends AgentTurnInput {
  /** Optional capability tier override for the forked turn. */
  tier?: ModelTier;
  /** Tool-surface mode for the fork. Defaults to `"isolated"`. */
  mode?: ForkRunMode;
  /** Exact provider-native history anchor for the source turn. */
  sourceCheckpoint?: ForkSourceCheckpoint;
  /**
   * Thread metadata the fork's action executions should carry (an exact-mode
   * fork inherits the source conversation's thread). Falls back to the source
   * session's own thread context when absent.
   */
  threadContext?: ThreadContext;
}

export type AgentSessionStatus = "idle" | "running" | "closed";

export interface AgentTurnHandle {
  turnId: string;
  events: AsyncIterable<StreamAgentMessage>;
  /** Cancel only this turn, including before provider dispatch. */
  interrupt?(reason?: string): Promise<void>;
  /**
   * OTel context carrying the per-turn `agent:*` span. Callers doing
   * post-turn work outside `runOneTurn` can wrap it in
   * `context.with(handle.turnContext, …)` so their spans land on the
   * same trace as the agent run.
   */
  turnContext: Context;
}

export interface SendTurnOptions {
  /**
   * OTel span links to attach to the per-turn `agent:*` root span. Used by
   * the webchat HTTP handler to tie a turn back to its originating POST
   * request without making the POST a parent (the POST span ends long
   * before the turn does).
   */
  links?: Link[];
  /** Turn-scoped parent ref used when this turn is launched as a subagent. */
  lifecycleParent?: AgentTurnParentRef;
  attachmentsCount?: number;
  threadContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
  /** Durable Rome session id when it differs from the runtime AgentSession id. */
  romeSessionId?: string;
  /** Durable Rome session kind used by Rome-owned navigation. */
  romeSessionType?: RomeSessionType;
  /** Platform message referenced by the current ordinary reply. */
  replyTo?: MessageReplyReference;
  initiatedBy?: "user" | "system";
}

export interface AgentSessionStatusEvent {
  key: AgentSessionKey;
  sessionId: string;
  status: AgentSessionStatus;
  turnId?: string;
}

export type AgentSessionSubscriber = (msg: StreamAgentMessage, turnId: string) => void;
export type AgentSessionStatusListener = (event: AgentSessionStatusEvent) => void;

export interface AgentSession {
  readonly key: AgentSessionKey;
  readonly sessionId: string;
  readonly romeSessionId?: string;
  readonly status: AgentSessionStatus;
  readonly currentTurnId?: string;
  /**
   * Synchronously allocate a turn and return its handle. The caller can read
   * `turnId` immediately and start consuming `events` (which yields once the
   * turn actually begins running turn-lock semantics).
   */
  sendTurn(input: AgentTurnInput, options?: SendTurnOptions): AgentTurnHandle;
  submitInput?(
    input: AgentTurnInput & { inputId: string },
    options: SubmitInputOptions,
  ): AgentInputReceipt;
  runForkedTurn?(input: ForkedAgentTurnInput): AsyncIterable<StreamAgentMessage>;
  subscribe(handler: AgentSessionSubscriber): () => void;
  onStatusChange(listener: AgentSessionStatusListener): () => void;
  interrupt(reason?: string, expectedTurnId?: string): Promise<void>;
  close(reason: "idle" | "shutdown" | "error" | "user"): Promise<void>;
}

export interface AgentSessionManager {
  acquire(key: AgentSessionKey, init?: AgentSessionInit): Promise<AgentSession>;
  acquireBySessionId?(
    sessionId: string,
    agentName: string,
    init?: AgentSessionInit,
  ): Promise<AgentSession>;
  peek(key: AgentSessionKey): AgentSession | undefined;
  shutdown(): Promise<void>;
}

interface ManagerDeps {
  agentLoader: AgentLoader;
  appCatalog?: Pick<AppCatalog, "get">;
  sessionManager: SessionManager;
  promptBuilder: PromptBuilder;
  actionRegistry: ActionRegistry;
  modelResolver: ModelResolver;
  actionEngine: ActionEngine;
  capabilityDiscovery: CapabilityDiscovery;
  skillCatalog: SkillCatalog;
  lifecycleDispatcher: AgentLifecycleDispatcher;
  /** Stable conversation transcript and notification context store. */
  webchatRepo?: WebChatRepository;
  subagentExecutionService?: SubagentExecutionService;
  activeSubagentRegistry?: ActiveSubagentRegistry;
  /** Turn-middleware onion. Optional — when absent, every turn runs the
   *  model terminal directly (behavior identical to a chain of size 0). */
  turnMiddleware?: TurnMiddlewareChain;
  /** Resolve the effective reset policy from the existing external thread identity. */
  resolveProviderSessionReset?: (ref: ConversationRef) => Promise<ProviderSessionResetPolicy>;
}

interface ManagerOptions {
  /** When true, sessions stay alive across turns (Phase 4). Default false. */
  keepAliveAcrossTurns?: boolean;
  /** Idle TTL for kept-alive sessions (defaults to 30 minutes). */
  idleTtlMs?: number;
  /**
   * True for managers that hand out subagent sessions (created via
   * `AgentSessionImpl.childManager`). Subagent runs block the parent turn and
   * only the main agent receives the next user turn, so subagents must not
   * expose tools that pause for a human reply (e.g. `propose_routine`, or an
   * action that renders an inline component).
   */
  isSubagent?: boolean;
}

async function waitUntilQuiescent(session: AgentSessionImpl): Promise<void> {
  if (session.status === "closed" || session.isQuiescentForRotation) return;
  await new Promise<void>((resolve) => {
    let unsubscribe = () => {};
    const done = () => {
      if (session.status !== "closed" && !session.isQuiescentForRotation) return;
      unsubscribe();
      resolve();
    };
    unsubscribe = session.onStatusChange(done);
    done();
  });
}

export function createAgentSessionManager(
  deps: ManagerDeps,
  options: ManagerOptions = {},
): AgentSessionManager {
  const sessions = new Map<string, AgentSessionImpl>();
  const acquireLocks = new Map<string, Promise<AgentSessionImpl>>();
  const lifecycleMutex = new KeyedMutex();
  const keepAlive = options.keepAliveAcrossTurns === true;
  const idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
  const isSubagent = options.isSubagent === true;

  const keyOf = (k: AgentSessionKey) => `${k.agentName}::${k.channelThreadKey}`;
  const canonicalizeKey = (key: AgentSessionKey): AgentSessionKey => ({
    ...key,
    agentName: deps.agentLoader.getCanonicalName(key.agentName),
  });

  let sweeperTimer: ReturnType<typeof setInterval> | null = null;
  if (keepAlive) {
    sweeperTimer =
      setInterval(
        () => {
          const cutoff = Date.now() - idleTtlMs;
          for (const session of [...sessions.values()]) {
            if (session.isQuiescentForRotation && session.lastActiveAt < cutoff) {
              void session.close("idle").catch(() => {
                // best-effort sweeper
              });
            }
          }
        },
        Math.min(60_000, idleTtlMs),
      ).unref?.() ?? null;
  }

  const onSessionClosed = (sess: AgentSessionImpl) => {
    sessions.delete(keyOf(sess.key));
  };

  const acquireInner = async (
    key: AgentSessionKey,
    span: Span,
    init?: AgentSessionInit,
  ): Promise<AgentSession> => {
    const k = keyOf(key);
    const resetRef =
      init?.platformMessageId &&
      init.threadContext?.connectionId &&
      deps.resolveProviderSessionReset
        ? {
            connectionId: init.threadContext.connectionId,
            conversationId: init.threadContext.threadId as ConversationId,
          }
        : undefined;
    if (init && resetRef && !init.resumeSessionId && !init.preparedSessionId) {
      const interactionAt = new Date();
      const reset = await deps.resolveProviderSessionReset!(resetRef);
      const conversationId = init.romeSessionId ?? init.threadContext?.romeSessionId;
      return await lifecycleMutex.runExclusive(k, async () => {
        const active = await deps.sessionManager.findReusableSession(
          key.channelThreadKey,
          key.agentName,
        );
        const decision = active
          ? evaluateProviderSessionReset(reset, active, interactionAt)
          : { due: false as const };
        const cached = sessions.get(k);
        if (decision.due) {
          log.info("provider_session.reset_due", {
            conversationId,
            agentName: key.agentName,
            provider: active?.provider ?? undefined,
            oldSessionId: active?.id,
            resetReason: decision.reason,
            policyMode: reset.mode,
            elapsedMinutes: decision.elapsedMinutes,
          });
          if (cached && cached.status !== "closed") {
            await waitUntilQuiescent(cached);
            await cached.close("idle");
          }
        }
        let preparedSessionId: string | undefined;
        if (decision.due) {
          const replacement = await deps.sessionManager.rotateProviderGeneration({
            agentName: key.agentName,
            channelThreadKey: key.channelThreadKey,
            newSessionId: uuidv4(),
          });
          preparedSessionId = replacement.id;
          log.info("provider_session.rotated", {
            conversationId,
            agentName: key.agentName,
            provider: active?.provider ?? undefined,
            oldSessionId: active?.id,
            newSessionId: replacement.id,
            resetReason: decision.reason,
            policyMode: reset.mode,
            result: "succeeded",
          });
        }
        return await acquireInner(key, span, {
          ...init,
          platformMessageId: undefined,
          ...(preparedSessionId ? { preparedSessionId } : {}),
        });
      });
    }
    let forceNewSession = init?.forceNewSession === true;
    // `reopen` distinguishes a cold open (no live session for this key — the
    // summon case, where a fresh random channelThreadKey never hits the cache)
    // from a reopen (a live session existed but was torn down for TTL/auth). The
    // `rome.session.acquire` counter exposes the reuse hit-rate that the 15s
    // keep-alive is supposed to buy but summon defeats by not passing a stable key.
    let reopen = false;
    // Prefer the per-call marker (the summon call-site threads `isSubagent`
    // through the RPC init) over the manager-wide default: the top-level
    // manager that serves blocking summons is created with `isSubagent=false`,
    // so labelling off the manager alone would mislabel every summon open.
    const isSubagentForMetric = init?.isSubagent ?? isSubagent;
    const recordAcquire = (outcome: "reuse" | "cold" | "reopen" | "coalesced") => {
      span.setAttribute("outcome", outcome);
      sessionAcquireMetric().add(1, {
        outcome,
        "agent.name": key.agentName,
        is_subagent: isSubagentForMetric,
      });
    };
    const existing = sessions.get(k);
    const explicitResume = init?.resumeSessionId;
    if (existing && existing.status !== "closed") {
      // A fork deliberately leaves the source's public status idle: it runs in
      // an isolated provider session and must not make the source chat look as
      // though it has a normal turn in flight. It still leases the source,
      // though, so neither explicit replacement nor reuse-timeout eviction may
      // close it until every fork has drained.
      const existingIsQuiescent = existing.isQuiescentForRotation;
      if (explicitResume && existing.sessionId !== explicitResume) {
        if (!existingIsQuiescent) {
          throw new Error(
            `Agent session "${explicitResume}" cannot be resumed while another session is running on this thread`,
          );
        }
        reopen = true;
        await existing.close("idle");
      } else if (explicitResume && existing.status === "idle" && !existingIsQuiescent) {
        // A consumer can finish draining turn_end while runOneTurn is still in
        // its final cleanup. With close-on-turn-boundary sessions, returning
        // that instance would enqueue the continuation behind a close that is
        // already inevitable. Let cleanup finish, then cold-resume the exact
        // persisted generation instead.
        await waitUntilQuiescent(existing);
        await existing.close("idle");
        reopen = true;
      } else if (explicitResume && existingIsQuiescent) {
        await existing.close("idle");
      } else if (existing.status === "idle") {
        // Provider/model changes are resolved at the serialized turn boundary.
        // Reusing the Rome session here preserves its turn queue and lets the
        // session swap only the model backend when needed.
        recordAcquire("reuse");
        return existing;
      } else {
        recordAcquire("reuse");
        return existing;
      }
    }
    const current = sessions.get(k);
    if (current && current.status !== "closed") {
      recordAcquire("reuse");
      return current;
    }
    const inflight = acquireLocks.get(k);
    if (inflight) {
      recordAcquire("coalesced");
      return await inflight;
    }
    recordAcquire(reopen ? "reopen" : "cold");
    const promise = (async () => {
      const sess = await openSession(
        deps,
        key,
        { ...(init ?? {}), forceNewSession },
        {
          keepAlive,
          onClosed: onSessionClosed,
          isSubagent,
        },
      );
      sessions.set(k, sess);
      return sess;
    })();
    acquireLocks.set(k, promise);
    try {
      return await promise;
    } finally {
      acquireLocks.delete(k);
    }
  };

  // Wrap each acquire in a `session.acquire` span so the reuse decision and any
  // cold `model.session.open` it triggers surface as a distinct phase in the
  // summon waterfall (the open nests under it via the active-span context). The
  // outcome (reuse/cold/reopen/coalesced) is stamped on the span by
  // `recordAcquire`, mirroring the `rome.session.acquire` counter.
  const acquire = (key: AgentSessionKey, init?: AgentSessionInit): Promise<AgentSession> => {
    const canonicalKey = canonicalizeKey(key);
    return withRomeSpan(
      "session.acquire",
      { "agent.name": canonicalKey.agentName, is_subagent: init?.isSubagent ?? isSubagent },
      (span) => acquireInner(canonicalKey, span, init),
    );
  };

  const acquireBySessionId = async (
    sessionId: string,
    agentName: string,
    init?: AgentSessionInit,
  ): Promise<AgentSession> => {
    const row = await deps.sessionManager.findResumableSessionById(sessionId, agentName);
    if (!row) {
      throw new Error(`Agent session "${sessionId}" was not found or cannot be resumed`);
    }
    return acquire(
      { agentName, channelThreadKey: row.channelThreadKey },
      { ...(init ?? {}), resumeSessionId: sessionId },
    );
  };

  return {
    acquire,
    acquireBySessionId,
    peek(key) {
      let canonicalKey: AgentSessionKey;
      try {
        canonicalKey = canonicalizeKey(key);
      } catch {
        return undefined;
      }
      const sess = sessions.get(keyOf(canonicalKey));
      return sess && sess.status !== "closed" ? sess : undefined;
    },
    async shutdown() {
      if (sweeperTimer) clearInterval(sweeperTimer);
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.all(all.map((s) => s.close("shutdown").catch(() => undefined)));
    },
  };
}

interface OpenOptions {
  keepAlive: boolean;
  onClosed: (s: AgentSessionImpl) => void;
  isSubagent: boolean;
}

/**
 * Identity + routing for tool executions on one logical turn owner. openSession
 * builds the execute callbacks (actions, subagents, submit_output, defer)
 * through these refs so one set of semantics serves two owners: the live
 * session (refs bound to the impl's current turn) and each exact-mode forked
 * turn (refs bound to the fork's own session/turn ids and outbound stream —
 * fork tool calls are attributed to the fork, not the source).
 */
interface TurnExecRefs {
  sessionId: string;
  getRomeSessionId: () => string;
  getTurnId: () => string | undefined;
  getThreadContext: () => ThreadContext | undefined;
  getSharedContext: () => Record<string, unknown> | undefined;
  /**
   * Whether this owner's tool results reach a surface that mounts interactive
   * UI. The live webchat session's drain loop does; a forked turn's stream has
   * no such drain, so fork refs set false and interactive action results
   * degrade to the same prose fallbacks messaging channels use — the advertised
   * tool catalog is unaffected (that's ModelSessionParams, not refs).
   */
  supportsInteractiveSurface: boolean;
  /**
   * Manager that owns this owner's subagent child sessions. The live session
   * hands out its own child manager; each exact fork gets a fork-owned manager
   * (disposed with the fork) so a fork's subagent turns never append to — or
   * create — a child session the source's turns reuse.
   */
  getChildManager: () => AgentSessionManager;
  /**
   * channelThreadKey under which this owner's children are acquired. Forks
   * namespace it with the fork session id: splitting the in-memory manager
   * alone would not stop the fork child's open from resuming the *source*
   * child's persisted session (findReusableSession matches on this key), which
   * would contaminate the same provider thread the source resumes later.
   */
  childChannelThreadKey: string;
  /** Exactly-once capture of a submit_output payload for the owning turn. */
  captureSubmittedOutput: (payload: unknown) => boolean;
  /** Attach the Child execution to this owner's provider tool call. */
  attachSubagentExecution: (toolUseId: string, execution: SubagentExecution) => void;
  /** Bind an async tool callback into the owner's OTel context. */
  bindTurnCtx: <T>(fn: () => T) => T;
}

/** Per-fork identity handed to `buildForkOpenParams` by `runForkedTurn`. */
interface ForkTurnContext {
  mode: ForkRunMode;
  forkSessionId: string;
  forkTurnId: string;
  /** Model id the fork opens with (caller-resolved tier override, else the source's live model). */
  model: string;
  /** Thread metadata for the fork's action executions (see ForkedAgentTurnInput). */
  threadContext?: ThreadContext;
  /**
   * Interleave an out-of-band message into the forked turn's stream.
   */
  emit: (msg: StreamAgentMessage) => void;
}

/**
 * What the open-params factory hands back to `runForkedTurn`.
 */
interface ForkOpen {
  params: ModelSessionForkOpenParams;
  /** Replace provider-generic subagent tool events with semantic ones. */
  projectProviderMessage: (msg: StreamAgentMessage) => Promise<StreamAgentMessage[]>;
  /**
   * Close fork-owned resources (the per-fork subagent child manager, if the
   * fork ran any subagents). runForkedTurn calls this from its finally, so
   * fork children never outlive the forked turn.
   */
  dispose: () => Promise<void>;
}

type BuildForkOpenParams = (fork: ForkTurnContext) => ForkOpen;

function resolveSelectionFromChannelThreadKey(
  channelThreadKey: string,
): WebchatLargeModelSelection | undefined {
  if (!channelThreadKey.startsWith("webchat:")) return undefined;
  const marker = ":large-model:";
  const markerIndex = channelThreadKey.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  return (
    resolveWebchatLargeModelSelection(channelThreadKey.slice(markerIndex + marker.length)) ??
    undefined
  );
}

async function openSession(
  deps: ManagerDeps,
  key: AgentSessionKey,
  init: AgentSessionInit,
  opts: OpenOptions,
): Promise<AgentSessionImpl> {
  const { config, metadata } = deps.agentLoader.getRecord(key.agentName);
  const owningApp =
    metadata.ownerType === "app" ? deps.appCatalog?.get(metadata.ownerId) : undefined;
  const appStoreListingId =
    owningApp?.source.mode === "appstore" ? owningApp.source.listingId : undefined;
  const workingDir = init.workingDir ?? (await ensureDefaultAgentWorkingDir());

  // Try to resume an existing SDK session through the stable channelThreadKey.
  // Scoping by agentName is load-bearing: subagents reuse the parent's key, so
  // without the agent filter a subagent could inherit its parent's provider
  // thread and system prompt/history.
  const requestedRomeSessionId = init.romeSessionId;
  let resumeResult:
    | {
        id: string;
        channelThreadKey?: string;
        provider: string | null;
        providerThreadId: string | null;
        model: string | null;
      }
    | undefined;
  if (init.preparedSessionId) {
    // The lifecycle transaction already inserted this fresh generation. Keep
    // resumeResult empty so provider open and prompt framing use new-session
    // semantics while retaining the transactionally allocated runtime id.
  } else if (init.resumeSessionId && !init.forceNewSession) {
    resumeResult = await deps.sessionManager.findResumableSessionById(
      init.resumeSessionId,
      key.agentName,
    );
    if (!resumeResult) {
      throw new Error(`Agent session "${init.resumeSessionId}" was not found or cannot be resumed`);
    }
    if (resumeResult.channelThreadKey !== key.channelThreadKey) {
      throw new Error(`Agent session "${init.resumeSessionId}" does not match this session key`);
    }
  } else if (key.channelThreadKey && !init.forceNewSession) {
    resumeResult = await deps.sessionManager.findReusableSession(
      key.channelThreadKey,
      key.agentName,
    );
  }

  const sessionId = init.preparedSessionId ?? resumeResult?.id ?? uuidv4();
  const romeSessionId = requestedRomeSessionId;
  const isNewSession = !resumeResult;
  const providerThreadId = resumeResult?.providerThreadId ?? undefined;
  // The session model pin: the concrete model that produced this
  // session's history. Authoritative for resume and every later turn —
  // resolution precedence is explicit guardian selection → pin → agent tier.
  // Legacy rows (model NULL) have no pin and resolve by tier.
  const sessionPin =
    resumeResult?.provider && resumeResult.model
      ? { providerId: resumeResult.provider as ProviderId, model: resumeResult.model }
      : undefined;
  // The channel-thread-key selection restores a webchat thread's chosen model
  // on cold resume. A pinned session no longer needs it (the pin records the
  // model that actually ran), so it only applies to unpinned (legacy) resumes.
  const persistedSelection =
    init.resumeSessionId && !sessionPin
      ? resolveSelectionFromChannelThreadKey(key.channelThreadKey)
      : undefined;
  // Resolution precedence: explicit guardian selection → pin → tier.
  // A restored selection is an explicit selection, so it always wins — the old
  // provider-mismatch guard that dropped it on resume is gone: a
  // legacy row that switches providers via its selection now follows the single
  // precedence rule instead of being pinned back to the stored provider's tier.
  const selectionId = init.selectionId ?? persistedSelection?.id;

  if (isNewSession && !init.preparedSessionId) {
    const dbSession: DbAgentSession = {
      id: sessionId,
      agentName: key.agentName,
      channelThreadKey: key.channelThreadKey,
      createdAt: new Date(),
      lastActiveAt: new Date(),
      status: "active",
    };
    await deps.sessionManager.createSession(dbSession);
  }

  if (config.outputSchema && init.handback) {
    throw new Error(
      `Agent ${key.agentName} cannot combine provider outputSchema with a conversational handback`,
    );
  }
  const conversationalHandback = init.handback;
  // Compile both boundaries once. Provider output uses portable-v1; handback
  // remains an internal UI contract and may use general JSON Schema.
  let structuredOutputValidator: CompiledOutputSchema | undefined;
  if (config.outputSchema) {
    try {
      structuredOutputValidator = compileOutputSchema(config.outputSchema);
    } catch (err) {
      throw new Error(
        `Agent ${key.agentName} declares an invalid outputSchema: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  let handbackValidator: CompiledOutputSchema | undefined;
  if (conversationalHandback) {
    try {
      handbackValidator = compileJsonSchema(conversationalHandback.schema);
    } catch (err) {
      throw new Error(
        `Agent ${key.agentName} declares an invalid handback schema: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Interactive inline UI (`propose_routine` cards, app components) pauses the
  // agent for a human reply. That only works when (a) the surface can render it
  // (the webchat surface — dashboard + desktop — does; messaging channels don't),
  // and (b) this session will actually receive the next user turn. Subagents fail
  // (b): the parent turn blocks on the child, and the next user turn always routes
  // to the main agent — so a suspended subagent call would hang forever. Where
  // this is false, an action that returns `renderComponent` falls back to relaying
  // its `promptText` as prose; see the executeAction shim below.
  const supportsInteractiveSurface =
    key.channelThreadKey.startsWith("webchat:") && !opts.isSubagent;

  const baseSystemPrompt = [
    deps.promptBuilder.build(config, {
      ownerType: metadata.ownerType,
      contextSuffix: init.contextSuffix,
    }),
    supportsInteractiveSurface && metadata.ownerType === "core"
      ? buildInteractiveSurfaceGuidanceSection()
      : null,
  ]
    .filter((section): section is string => !!section)
    .join("\n\n---\n\n");
  const systemPrompt = conversationalHandback
    ? baseSystemPrompt +
      "\n\n--- Result contract ---\n" +
      "A `submit_output` tool is available. Calling it is how you present a finished result for the guardian's approval — it surfaces an Approve control to them. So the moment you have a result you'd show them for sign-off, call `submit_output` once with it (matching the declared schema) AS you tell them it's ready and ask if they'd like any changes. Do NOT wait for the guardian to say 'yes' or 'it's done' first — submitting is what asks. Until you have something worth reviewing, converse normally; turns may end without calling it. The guardian then either clicks Approve, or approves in words. If they reply with changes, keep refining and call `submit_output` again when the updated result is ready. If they reply with an UNAMBIGUOUS approval of what you submitted (e.g. \"yes\", \"ship it\", \"looks good\", \"go ahead\"), call the `confirm_output` tool — that ships the result you last submitted, exactly as if they had clicked Approve. Only call `confirm_output` after a submit_output and only on a clear approval; for a question or any requested change, do not call it."
    : baseSystemPrompt;

  // The registry's `getForAgent` is the single resolution point for what this
  // agent may call — its allow-list plus the globally-granted actions, or
  // everything for "*". Both the model-facing catalog and the execution gate
  // derive from it, so they can't disagree. It's consulted per-request so an
  // action installed mid-conversation by `app_management` is callable in the
  // same session.
  const allowList = config.actions ?? [];
  const findPermittedAction = (name: string): Action | undefined => {
    const requestedAction = deps.actionRegistry.get(name);
    if (!requestedAction) return undefined;
    return deps.actionRegistry
      .getForAgent(allowList)
      .find((action) => action.config.name === requestedAction.config.name);
  };
  const toActionMcpDefinition = (a: Action): ActionMcpDefinition => ({
    name: a.config.name,
    description: a.config.description,
    type: a.config.type,
    complexity: a.config.complexity,
    speed: a.config.speed,
    reliability: a.config.reliability,
    sideEffects: a.config.sideEffects,
    requiresApproval: !!a.config.requiresApproval,
    cancellable: !!a.config.cancellable,
    inputSchema: a.inputSchema!,
  });
  const getActionCatalog = (): ActionMcpDefinition[] =>
    deps.actionRegistry.getForAgent(allowList).map(toActionMcpDefinition);
  // Live view onto SkillCatalog for the same reason as `getActionCatalog`:
  // app_management installs land in the catalog mid-session via the
  // AppCatalog subscriber chain (skillCatalog.loadFromCatalog), and the
  // facade tools must surface them without restarting the session.
  const getSkillCatalog = (): SkillMcpDefinition[] => deps.skillCatalog.getMcpDefinitions();
  const { tools: subagentTools, targets: subagentTargets } = buildSubagentTools(
    deps.agentLoader,
    config,
  );
  const subagentToolNames = new Set(subagentTools.map((tool) => tool.name));

  let externalMcpServers: Record<string, McpServerConfig> | undefined;
  if (config.networkDiscovery) {
    const discovered = deps.capabilityDiscovery.getCdpMcpServers();
    if (Object.keys(discovered).length > 0) {
      externalMcpServers = { ...config.mcpServers, ...discovered };
    }
  }

  // We hold the AgentSessionImpl handle in a closure so the executeAction
  // callback can route channel-context / shared-context from the right place.
  let impl!: AgentSessionImpl;

  // Re-bind into the current turn's OTel context so `action:*` spans land
  // under the agent span even when the SDK invokes this callback async.
  // The original `context.with(turnCtx, sendUserInput)` block has long
  // since returned by the time MCP tool callbacks fire.
  const inCurrentTurnCtx = <T>(fn: () => T): T => {
    const ctx = impl.currentTurnCtxRef ?? context.active();
    return context.with(ctx, fn);
  };

  // The execute callbacks are built through TurnExecRefs so one set of
  // semantics serves two owners: the live session (refs bound to the impl's
  // current turn, below) and each exact-mode forked turn (refs bound to the
  // fork's own session/turn ids and outbound stream — see buildForkOpenParams).
  const sessionExecRefs: TurnExecRefs = {
    sessionId,
    getRomeSessionId: () => impl.currentTurnRomeSessionIdRef,
    getTurnId: () => impl.currentTurnId,
    getThreadContext: () => impl.currentTurnThreadContextRef,
    getSharedContext: () => impl.currentTurnSharedContextRef,
    supportsInteractiveSurface,
    getChildManager: () => impl.childManager,
    childChannelThreadKey: key.channelThreadKey,
    captureSubmittedOutput: (payload) => impl.captureSubmittedOutput(payload),
    attachSubagentExecution: (toolUseId, execution) =>
      impl.addSubagentExecution(toolUseId, execution),
    bindTurnCtx: inCurrentTurnCtx,
  };

  const makeExecuteAction =
    (refs: TurnExecRefs) =>
    async (name: string, input: unknown): Promise<unknown> =>
      refs.bindTurnCtx(async () => {
        // Allow-list check is load-bearing for security: an agent yaml that
        // scopes `actions: [foo]` must not reach anything else in the registry.
        const action = findPermittedAction(name);
        if (!action) throw new Error(`Unknown action: ${name}`);
        const result = await deps.actionEngine.run(
          action.config.name,
          input as Record<string, unknown>,
          {
            initiator: `agent:${key.agentName}`,
            channelContext: refs.getThreadContext(),
            sharedContext: refs.getSharedContext(),
            sessionId: refs.sessionId,
            agentName: key.agentName,
            channelThreadKey: key.channelThreadKey,
            turnId: refs.getTurnId(),
          },
        );
        if (result.status === "pending_approval") {
          return {
            pendingApproval: true,
            approvalId: result.approval.approvalId,
            message:
              `Action "${result.approval.actionName}" was submitted for guardian approval. ` +
              `A proposal card has been shown to the guardian in the originating channel, and they will review it asynchronously. ` +
              `Do NOT wait for the result. Continue with any remaining work in this turn that does not depend on this action's output. ` +
              `When the guardian resolves the approval, a new turn will be started automatically with the outcome.`,
          };
        }
        if (result.status === "pending_interaction") {
          const { appId, promptText, render } = result.interaction;
          // Off-webchat (messaging channel), inside a subagent, or on a forked
          // turn: nothing can mount the component. Fall back to relaying the
          // human-readable prompt as prose; the guardian's reply arrives as
          // the next turn, exactly like an ordinary clarifying question.
          if (!refs.supportsInteractiveSurface) {
            return {
              message:
                "This surface cannot render an interactive UI. Ask the guardian the " +
                "following as a plain message, then wait for their reply before doing " +
                `anything else:\n\n${promptText}`,
            };
          }
          // Webchat: the chat client mounts the component off this tool_result
          // (the drain loop snapshots a pending_interaction card keyed by
          // toolUseId). The guardian's outcome arrives as a new turn, so tell the
          // agent to stop here rather than treating the directive as data.
          return {
            pendingInteraction: true,
            appId,
            render,
            message:
              `The "${render.componentId}" component has been shown to the guardian. It asks them to: ${promptText} ` +
              `Their response will arrive as the next turn's prompt — do not call any further tools ` +
              `or send another message until then. When you reply, describe only what this step does; ` +
              `do not claim any later step has already happened.`,
          };
        }
        if (result.status === "handoff") {
          const { appId, promptText, agentName, payload, handback, handbackHint } = result.handoff;
          // Off-webchat (messaging channel), inside a subagent, or on a forked
          // turn: nothing can run a handoff. Fall back to relaying the prompt
          // as prose, same as above.
          if (!refs.supportsInteractiveSurface) {
            return {
              message:
                "This surface cannot render an interactive UI. Ask the guardian the " +
                "following as a plain message, then wait for their reply before doing " +
                `anything else:\n\n${promptText}`,
            };
          }
          // Webchat: the drain loop snapshots a handoff card keyed by toolUseId and
          // mints the child session. The handoff mounts no surface itself — the
          // summoned agent brings one up via `show_app`. handback/handbackHint ride
          // on the tool_result so the drain loop can stamp the child session's
          // contract and the card's hint — the model-facing `message` is unchanged.
          return {
            handoff: true,
            appId,
            agentName,
            payload,
            handback,
            handbackHint,
            message:
              `Control has been handed off to the "${appId}" surface. ` +
              `The guardian will work there and the outcome (the handed-back artifact, or a dismissal) will arrive as a new turn. ` +
              `Do NOT call any further tools or send another message until then.`,
          };
        }
        if (result.status === "place_widget") {
          const { appId, route, params } = result.placement;
          // Fire-and-forget, NOT a park: the widget is mounted as a side effect
          // (the webchat drain loop emits a `widget_placement` event off this
          // tool_result) and the agent keeps going this turn. Off-webchat / inside
          // a subagent there is no workspace to place it on, so say so plainly
          // rather than implying the guardian can now see something they cannot.
          if (!refs.supportsInteractiveSurface) {
            return {
              message:
                `The "${appId}" widget could not be shown — this surface has no workspace to ` +
                `place it on. Continue without it.`,
            };
          }
          return {
            placeWidget: true,
            appId,
            ...(route !== undefined ? { route } : {}),
            ...(params !== undefined ? { params } : {}),
            message:
              `The "${appId}" widget has been placed on the guardian's workspace for them to ` +
              `glance at. This needed no input from them — continue as normal, and don't claim ` +
              `they have acted on it.`,
          };
        }
        if (result.status === "error") {
          return result;
        }
        return result.data ?? result;
      });
  const executeAction = makeExecuteAction(sessionExecRefs);

  // `defer`: schedule a one-off wakeup back into this same thread. The
  // facade tool relays here; we capture the live thread context off the session
  // key + current turn and create the one-off via `create_routine` directly
  // (not through the agent's action allow-list — `defer` is a built-in). Only
  // wired for guardian-facing threads with a real `channelThreadKey` to wake;
  // keyless/synthetic runs (e.g. envoy validation) and subagents (which reuse
  // the parent's thread key) get no defer tool — a wakeup is a top-level
  // conversation primitive.
  const deferEnabled = isGuardianFacingChannel(key.channelThreadKey) && !opts.isSubagent;
  const makeExecuteDefer =
    (refs: TurnExecRefs) =>
    async (input: DeferInput): Promise<unknown> =>
      refs.bindTurnCtx(async () =>
        runDefer(input, {
          context: {
            agentName: key.agentName,
            sessionId: refs.sessionId,
            channelContext: refs.getThreadContext(),
          },
          createRoutine: async (createArgs) => {
            const result = await deps.actionEngine.run("create_routine", createArgs, {
              initiator: `agent:${key.agentName}`,
              sessionId: refs.sessionId,
              agentName: key.agentName,
              channelThreadKey: key.channelThreadKey,
              turnId: refs.getTurnId(),
            });
            if (result.status === "error") throw new Error(result.error);
            if (result.status !== "ok") {
              throw new Error(`create_routine returned ${result.status}`);
            }
            return result.data;
          },
          now: Date.now(),
        }),
      );
  const executeDefer = deferEnabled ? makeExecuteDefer(sessionExecRefs) : undefined;

  const makeExecuteSubmitOutput =
    (refs: TurnExecRefs) =>
    async (input: unknown): Promise<unknown> =>
      refs.bindTurnCtx(async () => {
        if (!conversationalHandback) {
          throw new Error("submit_output is not configured for this session");
        }
        // A handback submission is a UI act: the webchat drain persists a
        // submission_card off the live session's stream and the guardian
        // approves it there. Nothing drains a forked turn's stream, so
        // accepting here would tell the model a review is pending that can
        // never happen. Reject before validation and capture.
        if (!refs.supportsInteractiveSurface) {
          return {
            ok: false,
            error:
              "This turn has no guardian approval surface — the submission cannot be shown or reviewed.",
            hint: "Do not call submit_output again. End the turn with the result stated as plain text instead.",
          };
        }
        // Schema validation first — failure is a tool error the agent must
        // fix and retry. Do not capture or emit anything; the turn stays open.
        if (handbackValidator && !handbackValidator.validate(input)) {
          const issues = formatOutputSchemaErrors(handbackValidator.validate.errors);
          return {
            ok: false,
            error: "Payload does not match this conversation's handback schema",
            issues,
            hint: "Fix the listed issues and call submit_output again.",
          };
        }
        // App-specific semantic gate, after the schema and before the
        // exactly-once capture (a bounced submission must not consume the
        // once). Fail closed: a validator that errors, throws, or returns a
        // malformed verdict rejects the submission — never waves it through.
        if (conversationalHandback.validate) {
          let verdict: { valid: boolean; errors?: string[] };
          try {
            const res = await deps.actionEngine.run(
              conversationalHandback.validate,
              input as Record<string, unknown>,
              {
                initiator: "system:handback-validate",
                sessionId: refs.sessionId,
                agentName: key.agentName,
                channelThreadKey: key.channelThreadKey,
                turnId: refs.getTurnId(),
              },
            );
            if (res.status !== "ok") {
              const reason = res.status === "error" ? res.error : `status ${res.status}`;
              verdict = { valid: false, errors: [`validator failed: ${reason}`] };
            } else {
              const data = res.data as { valid?: unknown; errors?: unknown } | undefined;
              verdict =
                typeof data?.valid === "boolean"
                  ? {
                      valid: data.valid,
                      errors: Array.isArray(data.errors) ? data.errors.map(String) : undefined,
                    }
                  : { valid: false, errors: ["validator returned no { valid } verdict"] };
            }
          } catch (err) {
            verdict = {
              valid: false,
              errors: [`validator failed: ${err instanceof Error ? err.message : String(err)}`],
            };
          }
          if (!verdict.valid) {
            return {
              ok: false,
              error: "Payload failed this conversation's validation",
              issues: verdict.errors ?? [],
              hint: "Fix the listed issues and call submit_output again. The submission was not accepted.",
            };
          }
        }
        // Exactly-once: reject a second submission within the same turn so
        // the agent can't silently overwrite an accepted payload.
        const accepted = refs.captureSubmittedOutput(input);
        if (!accepted) {
          return {
            ok: false,
            error: "submit_output was already called this turn",
            hint: "Do not call submit_output again. End the turn now.",
          };
        }
        return {
          ok: true,
          message:
            "Submission accepted and shown to the guardian for approval. End your turn with a one-line note that the result is awaiting their review; if they want changes, their feedback arrives as the next turn.",
        };
      });
  const executeSubmitOutput = conversationalHandback
    ? makeExecuteSubmitOutput(sessionExecRefs)
    : undefined;

  const makeExecuteSubagent =
    (refs: TurnExecRefs) =>
    async (name: string, input: unknown, toolContext: ModelToolCallContext): Promise<unknown> =>
      refs.bindTurnCtx(async () => {
        const parentTurnId = refs.getTurnId();
        if (!parentTurnId) {
          throw new Error("execute_subagent called outside an active Parent turn");
        }
        if (!deps.subagentExecutionService) {
          throw new Error("SubagentExecutionService is not configured");
        }
        const execution = await deps.subagentExecutionService.startSubagent(
          subagentTargets.get(name) ?? name,
          input as ExecuteSubagentInput,
          {
            parentSessionId: refs.getRomeSessionId(),
            parentAgentSessionId: refs.sessionId,
            parentTurnId,
            parentToolUseId: toolContext.toolUseId,
            parentAgentName: key.agentName,
            parentChannelThreadKey: refs.childChannelThreadKey,
            childManager: refs.getChildManager(),
            workingDir,
            threadContext: refs.getThreadContext(),
            sharedContext: refs.getSharedContext(),
          },
        );
        try {
          refs.attachSubagentExecution(toolContext.toolUseId, execution);
        } catch (err) {
          deps.activeSubagentRegistry?.clearByParent({
            sessionId: refs.sessionId,
            turnId: parentTurnId,
            toolUseId: toolContext.toolUseId,
          });
          await execution
            .interrupt("Parent turn ended before Child attachment")
            .catch(() => undefined);
          throw err;
        }
        return await execution.completion;
      });
  const executeSubagent = makeExecuteSubagent(sessionExecRefs);

  const reasoningEffort = init.reasoningEffort ?? config.reasoningEffort;

  const buildSessionParams = (
    resolution: ModelResolution,
    resumeProviderId?: string | null,
    resumeThreadId?: string,
  ): ModelSessionParams => ({
    model: resolution.model,
    systemPrompt,
    agentName: key.agentName,
    appStoreListingId,
    getActionCatalog,
    getSkillCatalog,
    subagentTools,
    outputSchema: config.outputSchema,
    handback: conversationalHandback,
    builtinTools: config.tools.filter((name) => resolution.modelProvider.builtinTools.has(name)),
    maxTurns: config.maxTurns,
    reasoningEffort,
    workingDir,
    externalMcpServers,
    sessionId,
    isNewSession: resumeProviderId !== resolution.modelProvider.id,
    providerThreadId: resumeProviderId === resolution.modelProvider.id ? resumeThreadId : undefined,
    executeAction,
    executeSubagent,
    executeSubmitOutput,
    executeDefer,
    supportsInteractiveSurface,
  });

  // Captured on every successful open (including reopens) so exact-mode forks
  // can mirror the live session's provider-visible surface field-for-field —
  // identity by construction: a field added to ModelSessionParams flows into
  // exact forks without a second hand-maintained list.
  let lastOpenParams: ModelSessionParams | undefined;

  const openModelSession = async (
    resolution: ModelResolution,
    resumeProviderId?: string | null,
    resumeThreadId?: string,
  ): Promise<ModelSession> => {
    const params = buildSessionParams(resolution, resumeProviderId, resumeThreadId);
    const resumed = params.isNewSession === false;
    const openStartMs = Date.now();
    const session = await withRomeSpan(
      "model.session.open",
      {
        provider: resolution.modelProvider.id,
        resumed,
        "agent.name": key.agentName,
        is_subagent: opts.isSubagent,
      },
      () => resolution.modelProvider.openSession(params),
    );
    modelSessionOpenMetric().record(Date.now() - openStartMs, {
      provider: resolution.modelProvider.id,
      resumed,
    });
    lastOpenParams = params;
    return session;
  };

  /**
   * Open-params factory for forked turns (see `runForkedTurn`). Both modes
   * inherit the source conversation's transcript; the mode decides the tool
   * surface the fork's session opens with:
   *
   * - "isolated": an empty tool surface — the fork can only read the inherited
   *   conversation and answer.
   * - "exact": spreads the live session's actual open params, so the
   *   model-visible prefix (system prompt + tool catalog) is identical to the
   *   source conversation by construction, and tool calls execute for real —
   *   through fresh callbacks attributed to the fork's own session/turn ids
   *, never the source's per-turn closures. The model stays the
   *   caller's choice (`tier` override allowed); callers who want provider
   *   prompt-cache reuse keep the source's model.
   */
  const buildForkOpenParams: BuildForkOpenParams = (fork) => {
    if (fork.mode !== "exact") {
      return {
        params: {
          model: fork.model,
          systemPrompt,
          agentName: key.agentName,
          appStoreListingId,
          workingDir,
          getActionCatalog: () => [],
          getSkillCatalog: () => [],
          subagentTools: [],
          outputSchema: config.outputSchema,
          builtinTools: [],
          reasoningEffort,
          executeAction: async () => {
            throw new Error("Actions are disabled in forked turns");
          },
          executeSubagent: async () => {
            throw new Error("Subagents are disabled in forked turns");
          },
          supportsInteractiveSurface: false,
        },
        projectProviderMessage: async (msg) => [msg],
        dispose: async () => {},
      };
    }
    if (!lastOpenParams) {
      // Only reachable for sessions that never opened a provider query
      // (code-backed) — and those refuse fork() before this factory runs.
      throw new Error("Exact fork requires a live provider session");
    }
    // The thread/shared context fall back to the session's
    // open-time values — NOT the impl's current-turn refs, which could belong
    // to an unrelated source turn running concurrently with the fork.
    // Fork-owned children: a fork's subagent must never append to (or create)
    // the child session the source's turns reuse — the child transcript is
    // state the source observably depends on, so sharing it breaks the "fork
    // never mutates the source" invariant. The separate manager isolates the
    // in-memory map; the namespaced thread key isolates session-store reuse
    // (findReusableSession would otherwise resume the source child's provider
    // thread). keepAlive gives one forked turn child continuity across
    // repeated calls to the same subagent; runForkedTurn disposes the manager
    // when the fork ends, so fork children never outlive the fork.
    let forkChildManager: AgentSessionManager | undefined;
    const forkSubagentExecutions = new Map<
      string,
      { parent: ParentSubagentRef; execution: SubagentExecution }
    >();
    const forkPendingSubagentUses = new Map<string, Extract<AgentMessage, { type: "tool_use" }>>();
    const forkEmittedSubagentStarts = new Set<string>();
    const maybeEmitForkSubagentStart = (toolUseId: string): void => {
      if (forkEmittedSubagentStarts.has(toolUseId)) return;
      const use = forkPendingSubagentUses.get(toolUseId);
      const linked = forkSubagentExecutions.get(toolUseId);
      if (!use || !linked) return;
      forkEmittedSubagentStarts.add(toolUseId);
      forkPendingSubagentUses.delete(toolUseId);
      fork.emit({
        type: "subagent_start",
        toolUseId,
        agentName: linked.execution.agentName,
        input: use.input,
        sessionId: linked.execution.sessionId,
        turnId: linked.execution.turnId,
        ...(use.startedAt ? { startedAt: use.startedAt } : {}),
      });
    };
    const refs: TurnExecRefs = {
      sessionId: fork.forkSessionId,
      getRomeSessionId: () => fork.forkSessionId,
      getTurnId: () => fork.forkTurnId,
      getThreadContext: () => fork.threadContext ?? init.threadContext,
      getSharedContext: () => init.sharedContext,
      // Nothing drains a fork stream into webchat, so interactive action
      // results (pending_interaction / handoff / place_widget) must take the
      // prose fallbacks — otherwise the tool_result claims a card was shown
      // while nothing mounted and the fork dead-ends.
      supportsInteractiveSurface: false,
      getChildManager: () => {
        if (!forkChildManager) {
          forkChildManager = createAgentSessionManager(deps, {
            keepAliveAcrossTurns: true,
            isSubagent: true,
          });
        }
        return forkChildManager;
      },
      childChannelThreadKey: `${key.channelThreadKey}#fork:${fork.forkSessionId}`,
      captureSubmittedOutput: () => false,
      attachSubagentExecution: (toolUseId, execution) => {
        forkSubagentExecutions.set(toolUseId, {
          parent: {
            sessionId: fork.forkSessionId,
            turnId: fork.forkTurnId,
            toolUseId,
          },
          execution,
        });
        maybeEmitForkSubagentStart(toolUseId);
      },
      // Forked turns open no agent span; run tool callbacks on the ambient
      // OTel context instead of re-binding into a source turn's span.
      bindTurnCtx: (fn) => fn(),
    };
    const {
      sessionId: _sessionId,
      isNewSession: _isNewSession,
      providerThreadId: _providerThreadId,
      fork: _forkSource,
      ...liveOpenParams
    } = lastOpenParams;
    return {
      params: {
        ...liveOpenParams,
        model: fork.model,
        executeAction: makeExecuteAction(refs),
        executeSubagent: makeExecuteSubagent(refs),
        executeSubmitOutput: conversationalHandback ? makeExecuteSubmitOutput(refs) : undefined,
        executeDefer: deferEnabled ? makeExecuteDefer(refs) : undefined,
        // The spread keeps `supportsInteractiveSurface` (it shapes the
        // advertised catalog + system prompt, which must stay byte-identical
        // to the source); this flag makes the interactive *runtime* degrade
        // to the non-interactive fallbacks instead — see
        // FacadeParams.interactiveSurfaceDetached.
        interactiveSurfaceDetached: true,
      },
      projectProviderMessage: async (msg) => {
        if (msg.type === "tool_use" && subagentToolNames.has(msg.tool)) {
          forkPendingSubagentUses.set(msg.id, msg);
          maybeEmitForkSubagentStart(msg.id);
          return [];
        }
        if (msg.type !== "tool_result") return [msg];
        const linked = forkSubagentExecutions.get(msg.toolUseId);
        if (linked) {
          const completion = await linked.execution.completion;
          deps.activeSubagentRegistry?.clearByParent(linked.parent);
          const common = {
            type: "subagent_result" as const,
            toolUseId: msg.toolUseId,
            agentName: linked.execution.agentName,
            sessionId: completion.sessionId,
            turnId: completion.turnId,
            ...(msg.endedAt ? { endedAt: msg.endedAt } : {}),
          };
          return [
            completion.status === "completed"
              ? { ...common, status: completion.status, output: completion.output }
              : { ...common, status: completion.status, error: completion.error },
          ];
        }
        const pendingUse = forkPendingSubagentUses.get(msg.toolUseId);
        if (!pendingUse) return [msg];
        forkPendingSubagentUses.delete(msg.toolUseId);
        return [pendingUse, msg];
      },
      dispose: async () => {
        await Promise.allSettled(
          [...forkSubagentExecutions.values()].map(({ execution }) =>
            execution.interrupt("Forked Parent turn ended"),
          ),
        );
        for (const { parent } of forkSubagentExecutions.values()) {
          deps.activeSubagentRegistry?.clearByParent(parent);
        }
        if (forkChildManager) await forkChildManager.shutdown();
      },
    };
  };
  // A code-backed agent opens no provider query — its turns are
  // always produced by a turn-middleware. This both saves a needless model
  // session and avoids the resume-on-reuse error a never-used provider session
  // would raise on the second turn (there is no SDK conversation to resume).
  let modelSession: ModelSession;
  let initialResolution: ModelResolution | undefined;
  if (config.codeBacked) {
    modelSession = createNullModelSession({
      ...buildSessionParams({
        modelProvider: {
          id: "mock",
          displayName: "Code-backed",
          builtinTools: new Set(),
          openSession: async () => {
            throw new Error("Code-backed agents do not open model sessions");
          },
        },
        model: "code-backed",
      }),
      isNewSession: true,
    });
  } else {
    // Precedence: explicit guardian selection → session pin → agent
    // tier. A pinned resume requests exactly the pinned model and fails closed
    // (structured ModelResolutionError) when it cannot run — no substitution.
    initialResolution = await deps.modelResolver.getModelProvider(
      !selectionId && sessionPin
        ? { exact: sessionPin }
        : { tier: config.tier, selectionId, providerId: config.providerId },
    );
    modelSession = await openModelSession(
      initialResolution,
      resumeResult?.provider,
      providerThreadId,
    );
  }

  impl = new AgentSessionImpl({
    key,
    sessionId,
    romeSessionId,
    modelSession,
    deps,
    config,
    structuredOutputValidator,
    systemPrompt,
    workingDir,
    buildForkOpenParams,
    threadContext: init.threadContext,
    sharedContext: init.sharedContext,
    isNewSession,
    isSubagent: opts.isSubagent,
    selectionId,
    sessionPin,
    openModelSession,
    toolCount:
      (initialResolution
        ? config.tools.filter((name) => initialResolution.modelProvider.builtinTools.has(name))
            .length
        : 0) + subagentTools.length,
    subagentToolNames,
    keepAlive: opts.keepAlive,
    onClosed: () => opts.onClosed(impl),
  });

  impl.startModelSessionEvents();

  log.info("agent session opened", {
    agentName: key.agentName,
    sessionId,
    isNewSession,
    channelThreadKey: key.channelThreadKey,
  });

  return impl;
}

interface ImplArgs {
  key: AgentSessionKey;
  sessionId: string;
  romeSessionId?: string;
  modelSession: ModelSession;
  deps: ManagerDeps;
  config: ReturnType<AgentLoader["get"]>;
  structuredOutputValidator?: CompiledOutputSchema;
  systemPrompt: string;
  workingDir: string;
  /** Builds the open params for a forked turn's session (mode-aware). */
  buildForkOpenParams: BuildForkOpenParams;
  threadContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
  /** Whether the underlying SDK session was freshly minted (vs resumed). */
  isNewSession: boolean;
  /** Subagent sessions get no thread-context block (they get no contextSuffix today either). */
  isSubagent: boolean;
  selectionId?: ModelSelectionId;
  /** Session model pin from the resumed row, when one exists. */
  sessionPin?: { providerId: ProviderId; model: string };
  openModelSession: (
    resolution: ModelResolution,
    resumeProviderId?: string | null,
    resumeThreadId?: string,
  ) => Promise<ModelSession>;
  /** Tools advertised to the model: builtin SDK tools + subagent tools. */
  toolCount: number;
  subagentToolNames: Set<string>;
  keepAlive: boolean;
  onClosed: () => void;
}

interface TurnSink {
  turnId: string;
  /** Prompt that opened the turn; carried on the turn_start event. */
  userPrompt: string;
  /** Guards the one-turn_start-per-stream invariant across error paths. */
  turnStartEmitted: boolean;
  values: StreamAgentMessage[];
  resolvers: Array<(item: IteratorResult<StreamAgentMessage>) => void>;
  done: boolean;
  /**
   * Captured block stream for this turn — every AgentMessage yielded by
   * `modelSession.events` on this turn, with the wall-clock ts we observed
   * it at. Drained at terminal time by `translateTurnSpans` to emit
   * `tool` spans + thinking/text events under `model.turn`. Includes blocks
   * the sink itself drops (e.g. subagent tool_results) so per-tool spans
   * are still reconstructed for subagent dispatch from the parent's view.
   */
  blocks: CapturedBlock[];
  /** Captured at turn start; used as the floor for tool startedAt values. */
  modelTurnStartMs: number;
  /**
   * Set once the first streamed event of the turn is observed, so the
   * `rome.model.turn.ttft` histogram (time-to-first-token) is recorded exactly
   * once even though the events loop sees many messages per turn.
   */
  ttftRecorded: boolean;
  /**
   * Identifying attrs (agent.name, session.id, turn.id, channel.*) computed
   * once in sendTurn and stamped on every span this turn creates. Carried
   * here rather than via OTel baggage so they don't leak into outbound
   * HTTP/gRPC headers via the default propagator.
   */
  romeAttrs: Attributes;
  lifecycleStartedAt?: string;
  lifecycleStartedAtMs?: number;
  lifecycleParent?: AgentTurnParentRef;
  lifecycleAttachmentsCount?: number;
  threadContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
  romeSessionId: string;
  romeSessionType: RomeSessionType;
  replyTo?: MessageReplyReference;
  initiatedBy?: "user" | "system";
  lifecycleFinishDispatched: boolean;
  lifecycleInterrupted: boolean;
  subagentExecutions: Map<string, { parent: ParentSubagentRef; execution: SubagentExecution }>;
  pendingSubagentToolUses: Map<string, Extract<AgentMessage, { type: "tool_use" }>>;
  emittedSubagentStarts: Set<string>;
  subagentLinksCleared: boolean;
  /** A schema-bound turn is terminal-only and cannot be resumed after a parked action. */
  outputSchemaSuspended: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * True when a tool result parked the turn on a pending interaction, approval,
 * or handoff. Facade results may reach us directly, JSON-encoded, or wrapped
 * in an MCP text-content array, so normalize all three shapes.
 */
function toolResultSuspendsTurn(output: unknown): boolean {
  let value: unknown = output;
  if (isRecord(value) && Array.isArray(value.content)) value = value.content;
  if (Array.isArray(value)) {
    const textBlock = value.find(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) && block.type === "text" && typeof block.text === "string",
    );
    value = textBlock?.text;
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  return (
    isRecord(value) &&
    (value.pendingInteraction === true || value.pendingApproval === true || value.handoff === true)
  );
}

function validateProviderStructuredResult(
  message: AgentMessage,
  compiled: CompiledOutputSchema | undefined,
  suspended = false,
): AgentMessage {
  if (!compiled || message.type !== "result") return message;
  if (suspended) {
    return {
      type: "error",
      error: "Agent cannot suspend a turn while outputSchema is configured",
      accounting: message.accounting,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(message, "structuredOutput")) {
    return {
      type: "error",
      error: "Provider completed without structured output for the declared outputSchema",
      accounting: message.accounting,
    };
  }
  if (!compiled.validate(message.structuredOutput)) {
    return {
      type: "error",
      error: `Provider returned structured output that failed Rome validation: ${formatOutputSchemaErrors(
        compiled.validate.errors,
      ).join("; ")}`,
      accounting: message.accounting,
    };
  }
  try {
    return { ...message, content: JSON.stringify(message.structuredOutput) };
  } catch (err) {
    return {
      type: "error",
      error: `Provider returned non-serializable structured output: ${
        err instanceof Error ? err.message : String(err)
      }`,
      accounting: message.accounting,
    };
  }
}

/**
 * Serialized outbound stream for one forked turn. The provider-event pump and
 * out-of-band emitters (for example exact-mode subagent relays) push
 * concurrently; `runForkedTurn` drains in arrival order. Pushes after `end()`
 * are dropped; anything pushed after the drain loop stops at the terminal
 * block is buffered but never read.
 */
class ForkStreamQueue implements AsyncIterable<StreamAgentMessage> {
  private buffer: StreamAgentMessage[] = [];
  private resolvers: Array<(item: IteratorResult<StreamAgentMessage>) => void> = [];
  private ended = false;

  push(msg: StreamAgentMessage): void {
    if (this.ended) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamAgentMessage> {
    return {
      next: async (): Promise<IteratorResult<StreamAgentMessage>> => {
        if (this.buffer.length > 0) {
          return { value: this.buffer.shift()!, done: false };
        }
        if (this.ended) return { value: undefined as never, done: true };
        return await new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

class AgentSessionImpl implements AgentSession {
  readonly key: AgentSessionKey;
  readonly sessionId: string;
  readonly romeSessionId?: string;
  status: AgentSessionStatus = "idle";
  currentTurnId?: string;
  lastActiveAt = Date.now();
  private activeForkedTurnCount = 0;
  // Manager built lazily for subagent runs; keeps subagents owned by this session.
  private _childManager?: AgentSessionManager;
  private modelSession: ModelSession;
  private deps: ManagerDeps;
  private config: ReturnType<AgentLoader["get"]>;
  private structuredOutputValidator?: CompiledOutputSchema;
  private systemPrompt: string;
  private workingDir: string;
  private buildForkOpenParams: BuildForkOpenParams;
  private threadContext?: ThreadContext;
  private sharedContext?: Record<string, unknown>;
  private subscribers = new Map<string, AgentSessionSubscriber>();
  private statusListeners = new Map<string, AgentSessionStatusListener>();
  private currentSink: TurnSink | null = null;
  /** Exactly-once submission for the current conversational handback turn. */
  private submittedOutputTurnId?: string;
  // Spans for the current turn. Both are opened in runOneTurn and closed in
  // runEventsLoop when the terminal `result`/`error` message lands, so the
  // trace contract is complete by the time the sink closes (i.e. before
  // consumer for-await loops drain). runOneTurn's finally is idempotent.
  private currentAgentSpan: Span | null = null;
  private currentModelSpan: Span | null = null;
  // Active OTel context for the current turn, set in runOneTurn after the
  // agent span is created. executeAction / executeSubagent re-bind into it
  // so `action:*` and child `agent:*` spans land under the current agent
  // span even when the model SDK invokes the MCP callback asynchronously
  // after the original `context.with(turnCtx, sendUserInput)` call has
  // returned.
  private currentTurnCtx: Context | null = null;
  // Per-turn counters stamped on the agent span at turn boundary.
  private currentTurnToolCallCount = 0;
  private currentTurnSkillWritten = false;
  private currentTurnStartMs = 0;
  // Captured at session open; passed through to per-turn span attrs.
  private isNewSession: boolean;
  private isSubagent: boolean;
  // One-shot guard: the `<thread_context>` block is prepended to the FIRST user
  // turn of a fresh session only. Flipped the first time runOneTurn considers it
  // so it never reappears on later turns of the same session.
  private threadContextInjected = false;
  private selectionId?: ModelSelectionId;
  /**
   * The session model pin: the concrete model this session's history
   * was produced on. Seeded from the resumed row at open and refreshed after
   * every successful pin persist, so per-turn re-resolution requests exactly
   * this model (never a tier re-map) once a pin exists.
   */
  private sessionPin?: { providerId: ProviderId; model: string };
  private openModelSession: ImplArgs["openModelSession"];
  private modelEventsLoop: Promise<void> | null = null;
  private modelSessionAvailable = true;
  private replacingModelSession: ModelSession | null = null;
  private toolCount: number;
  private subagentToolNames: Set<string>;
  private readonly turnMutex = new Mutex();
  private readonly inputs = new AgentInputQueue(
    (input, options) => this.sendTurn(input, options),
    () => this.modelSession,
    (error) =>
      log.warn("conversational input dispatch failed", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
  private keepAlive: boolean;
  private onClosed: () => void;
  private closingPromise?: Promise<void>;

  constructor(args: ImplArgs) {
    this.key = args.key;
    this.sessionId = args.sessionId;
    this.romeSessionId = args.romeSessionId;
    this.modelSession = args.modelSession;
    this.deps = args.deps;
    this.config = args.config;
    this.structuredOutputValidator = args.structuredOutputValidator;
    this.systemPrompt = args.systemPrompt;
    this.workingDir = args.workingDir;
    this.buildForkOpenParams = args.buildForkOpenParams;
    this.threadContext = args.threadContext;
    this.sharedContext = args.sharedContext;
    this.isNewSession = args.isNewSession;
    this.isSubagent = args.isSubagent;
    this.selectionId = args.selectionId;
    this.sessionPin = args.sessionPin;
    this.openModelSession = args.openModelSession;
    this.toolCount = args.toolCount;
    this.subagentToolNames = args.subagentToolNames;
    this.keepAlive = args.keepAlive;
    this.onClosed = args.onClosed;
  }

  /** Current per-turn OTel context, exposed for closures that need to bind
   * SDK-async callbacks back into the agent span. */
  get currentTurnCtxRef(): Context | null {
    return this.currentTurnCtx;
  }

  get providerId(): ProviderId {
    return this.modelSession.providerId;
  }

  get currentTurnThreadContextRef(): ThreadContext | undefined {
    return this.currentSink?.threadContext ?? this.threadContext;
  }

  get currentTurnSharedContextRef(): Record<string, unknown> | undefined {
    return this.currentSink?.sharedContext ?? this.sharedContext;
  }

  get currentTurnRomeSessionIdRef(): string {
    return this.currentSink?.romeSessionId ?? this.sessionId;
  }

  /**
   * Forks keep the source provider session alive without changing the source
   * chat's user-facing idle/running status. The manager consults this lease
   * before applying its short in-memory idle-eviction window.
   */
  get hasActiveForkedTurns(): boolean {
    return this.activeForkedTurnCount > 0;
  }

  get isQuiescentForRotation(): boolean {
    return (
      this.status === "idle" &&
      !this.turnMutex.isLocked() &&
      !this.hasActiveForkedTurns &&
      !this.inputs.busy
    );
  }

  get childManager(): AgentSessionManager {
    if (!this._childManager) {
      // Children share the same dep wiring + keepAlive setting. Flag the
      // child manager as subagent-only so human-blocking surfaces (propose_routine,
      // inline components) stay disabled on these sessions even when the parent
      // runs on webchat — see openSession's supportsInteractiveSurface.
      this._childManager = createAgentSessionManager(this.deps, {
        keepAliveAcrossTurns: this.keepAlive,
        isSubagent: true,
      });
    }
    return this._childManager;
  }

  // Per-session events loop: pumps every SDK AgentMessage into the active
  // turn sink. Turn boundaries are detected by `result` / `error`.

  startModelSessionEvents(): void {
    const session = this.modelSession;
    this.modelEventsLoop = this.runEventsLoop(session);
  }

  private async ensureModelSessionForTurn(): Promise<void> {
    if (this.config.codeBacked) return;
    // Precedence: explicit guardian selection → session pin → agent
    // tier. Once a pin exists, every turn requests exactly the pinned model:
    // entitlement/setting changes no longer swap an ongoing session's backend,
    // and a pin that cannot run fails the turn with the structured
    // ModelResolutionError instead of silently substituting a model.
    const resolution = await this.deps.modelResolver.getModelProvider(
      !this.selectionId && this.sessionPin
        ? { exact: this.sessionPin }
        : {
            tier: this.config.tier,
            selectionId: this.selectionId,
            providerId: this.config.providerId,
          },
    );
    if (
      this.modelSessionAvailable &&
      !this.modelSession.isClosed &&
      resolution.modelProvider.id === this.modelSession.providerId &&
      resolution.model === this.modelSession.model
    ) {
      return;
    }

    const previous = this.modelSession;
    const sameProvider = previous.providerId === resolution.modelProvider.id;
    const resumeThreadId = sameProvider ? previous.providerThreadId : undefined;
    this.replacingModelSession = previous;
    this.modelSessionAvailable = false;
    try {
      await previous.close();
      await this.modelEventsLoop;
      const next = await this.openModelSession(
        resolution,
        sameProvider ? previous.providerId : undefined,
        resumeThreadId,
      );
      this.modelSession = next;
      this.modelSessionAvailable = true;
      this.providerInfoStored = false;
      this.toolCount =
        this.config.tools.filter((name) => resolution.modelProvider.builtinTools.has(name)).length +
        buildSubagentTools(this.deps.agentLoader, this.config).tools.length;
      this.replacingModelSession = null;
      this.startModelSessionEvents();
    } catch (err) {
      this.replacingModelSession = null;
      throw err;
    }
  }

  private async runEventsLoop(session: ModelSession): Promise<void> {
    let streamError: unknown;
    try {
      enterSession(this.sessionId);
      for await (const msg of session.events) {
        const sink = this.currentSink;
        if (!sink) {
          // No active turn — log and drop. Should not happen because
          // sendTurn allocates the sink before sendUserInput.
          log.warn("agent session received event with no active turn", {
            type: msg.type,
            sessionId: this.sessionId,
          });
          continue;
        }
        if (msg.type === "input_status") {
          await this.inputs.observe(msg, sink.turnId);
          this.publishOutbound(sink, { ...msg, turnId: sink.turnId });
          continue;
        }
        if (msg.type === "result" || msg.type === "error") await this.inputs.seal(sink.turnId);
        // Time-to-first-token: the first *text* event of the turn (a text_delta
        // preview or a completed text block) marks when the model started
        // producing visible output. Gate strictly to text — thinking/tool_use
        // can precede any token (Codex emits tool_use before agentMessageDelta),
        // and counting those would make tool-first turns look artificially fast.
        // For a cold summon this is dominated by uncached first-turn prompt
        // processing, so it isolates that cost from the whole-turn duration
        // `modelTurnDurationMetric` already records.
        if (
          !sink.ttftRecorded &&
          sink.modelTurnStartMs > 0 &&
          (msg.type === "text_delta" || msg.type === "text")
        ) {
          sink.ttftRecorded = true;
          const ttftMs = Date.now() - sink.modelTurnStartMs;
          modelTurnTtftMetric().record(ttftMs, {
            "model.id": this.modelSession.model,
            "agent.name": this.key.agentName,
            is_subagent: this.isSubagent,
          });
          this.currentModelSpan?.setAttribute("ttft_ms", ttftMs);
        }
        // text_delta is a transient preview of an in-flight text block — the
        // complete block still follows. Fast-path it straight to the sink:
        // no span-translator capture, no per-delta DB touch, no metrics.
        if (msg.type === "text_delta") {
          this.publishOutbound(sink, msg);
          continue;
        }
        // Capture every block (including subagent tool_results we'll drop
        // from the sink below) for the per-turn span translator. The
        // translator runs on terminal and needs the full block stream to
        // reconstruct rounds and tool pairs.
        sink.blocks.push({ block: msg, tsMs: Date.now() });
        if (
          this.structuredOutputValidator &&
          msg.type === "tool_result" &&
          toolResultSuspendsTurn(msg.output)
        ) {
          sink.outputSchemaSuspended = true;
        }
        this.trackTurnMetrics(msg);
        await this.deps.sessionManager.touchSession(this.sessionId);

        if (msg.type === "tool_use" && this.subagentToolNames.has(msg.tool)) {
          sink.pendingSubagentToolUses.set(msg.id, msg);
          this.maybePublishSubagentStart(sink, msg.id);
          continue;
        }
        if (msg.type === "tool_result") {
          const linked = sink.subagentExecutions.get(msg.toolUseId);
          if (linked) {
            const completion = await linked.execution.completion;
            const common = {
              type: "subagent_result" as const,
              toolUseId: msg.toolUseId,
              agentName: linked.execution.agentName,
              sessionId: completion.sessionId,
              turnId: completion.turnId,
              ...(msg.endedAt ? { endedAt: msg.endedAt } : {}),
            };
            this.publishOutbound(
              sink,
              completion.status === "completed"
                ? { ...common, status: completion.status, output: completion.output }
                : { ...common, status: completion.status, error: completion.error },
            );
            continue;
          }
          const pendingUse = sink.pendingSubagentToolUses.get(msg.toolUseId);
          if (pendingUse) {
            sink.pendingSubagentToolUses.delete(msg.toolUseId);
            this.publishOutbound(sink, pendingUse);
          }
        }
        let outbound: AgentMessage = validateProviderStructuredResult(
          msg,
          this.structuredOutputValidator,
          sink.outputSchemaSuspended,
        );

        if (outbound.type === "error" && outbound.code === "auth_revoked") {
          // The provider process/session may have cached the rejected
          // credential. Even after the guardian signs in again, never send a
          // later turn through this backend; reopen it with fresh auth state.
          this.modelSessionAvailable = false;
          if (session.providerId === "openai" || session.providerId === "anthropic") {
            outbound = { ...outbound, provider: session.providerId };
          }
        }

        this.publishOutbound(sink, outbound);

        if (isTerminalBlock(outbound)) {
          // The branch action becomes available when turn_end is published.
          // Persist the provider-native anchor first so an immediate click can
          // never fall back to (or race with) a later provider-thread head.
          if (outbound.type === "result") {
            const interrupted =
              sink.lifecycleInterrupted || outbound.accounting?.stopReason === "interrupted";
            if (!interrupted) await this.maybePersistTurnCheckpoint(session, sink.turnId);
            await this.maybePersistProviderInfo();
          }
          // Use `outbound` (not `msg`) so provider-output validation is
          // reflected in span status and the turn_end bracket. The turn_end
          // bracket ships after the spans close, so the trace contract is
          // complete by the time consumers observe the end of the turn.
          this.finalizeTurn(sink, outbound);
        }
      }
    } catch (err) {
      streamError = err;
      log.warn("agent session events loop ended", {
        sessionId: this.sessionId,
        provider: session.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (this.replacingModelSession === session || this.modelSession !== session) return;
      const sink = this.currentSink;
      if (session.isClosed) {
        this.modelSessionAvailable = false;
        if (sink && !sink.done) {
          if (sink.lifecycleInterrupted && !streamError) {
            this.finalizeTurn(sink, { type: "result", content: "" });
          } else {
            this.failTurn(
              sink,
              streamError instanceof Error ? streamError.message : "session closed mid-turn",
            );
          }
        }
        return;
      }
      this.inputs.close();
      if (sink && !sink.done) {
        this.failTurn(sink, "session closed mid-turn");
      }
      this.status = "closed";
      this.emitStatus();
      this.onClosed();
    }
  }

  /**
   * Emit the sink's turn_start exactly once. The normal path calls this at
   * turn open in runOneTurn; failure paths that terminate a turn that never
   * started (session closed, sendTurn threw) call it from failTurn so every
   * stream is bracketed: turn_start first, turn_end last.
   */
  private ensureTurnStart(sink: TurnSink): void {
    if (sink.turnStartEmitted) return;
    sink.turnStartEmitted = true;
    this.publishOutbound(sink, {
      type: "turn_start",
      turnId: sink.turnId,
      sessionId: this.sessionId,
      userPrompt: sink.userPrompt,
    });
  }

  /** Emit the turn_end bracket. `terminal` determines the status. */
  private publishTurnEnd(sink: TurnSink, terminal: AgentMessage): void {
    // Turns that fail before dispatchTurnStarted have no start timestamp;
    // report 0 rather than a since-epoch wall clock.
    const startMs = sink.lifecycleStartedAtMs;
    // Same precedence as classifyAgentTurnStatus: a user stop is reported as
    // `interrupted` even when the provider surfaced the abort as an error
    // block, so consumers can tell a graceful stop from a true failure
    // without peeking back into the terminal's accounting.
    const accounting =
      terminal.type === "result" || terminal.type === "error" ? terminal.accounting : undefined;
    const interrupted = sink.lifecycleInterrupted || accounting?.stopReason === "interrupted";
    this.publishOutbound(sink, {
      type: "turn_end",
      turnId: sink.turnId,
      status: interrupted ? "interrupted" : terminal.type === "error" ? "error" : "completed",
      durationMs: startMs === undefined ? 0 : Date.now() - startMs,
    });
  }

  /**
   * Close the current turn's model + agent spans against the terminal block.
   * Stamps accounting attrs on the per-turn model.turn span and ends it
   * before the sink, so observers see attrs by the time the turn boundary
   * ships. Runs on the normal terminal path (runEventsLoop) and on
   * synthetic-error exits (failTurn), so a failed turn's spans carry ERROR
   * status instead of being closed as OK by runOneTurn's safety net.
   */
  private finalizeTurnSpans(sink: TurnSink, outbound: ResultMessage | ErrorMessage): void {
    const modelSpan = this.currentModelSpan;
    if (modelSpan) {
      const accounting = outbound.accounting;
      if (accounting) {
        const u = accounting.usage;
        modelSpan.setAttributes({
          input_tokens: u.inputTokens ?? 0,
          output_tokens: u.outputTokens ?? 0,
          cache_read_input_tokens: u.cacheReadTokens ?? 0,
          cache_creation_input_tokens: u.cacheWriteTokens ?? 0,
          ...(accounting.context
            ? {
                context_used_tokens: accounting.context.usedTokens,
                ...(accounting.context.windowTokens !== undefined
                  ? { context_window_tokens: accounting.context.windowTokens }
                  : {}),
                ...(accounting.context.remainingTokens !== undefined
                  ? { context_remaining_tokens: accounting.context.remainingTokens }
                  : {}),
              }
            : {}),
          ...(accounting.costUsd !== undefined ? { estimated_cost_usd: accounting.costUsd } : {}),
          ...(accounting.stopReason ? { stop_reason: accounting.stopReason } : {}),
          ...(accounting.numTurns !== undefined ? { num_turns: accounting.numTurns } : {}),
        });
        // Prompt-cache outcome: a cold session (no reuse) reads nothing from the
        // cache and pays full prompt-processing latency on turn one. Tracking
        // hit/miss across many turns confirms whether summon's fresh-key opens
        // are consistently cache-cold vs. the warm guardian thread.
        modelPromptCacheMetric().add(1, {
          outcome: (u.cacheReadTokens ?? 0) > 0 ? "hit" : "miss",
          "model.id": this.modelSession.model,
          is_subagent: this.isSubagent,
        });
      }
      if (outbound.type === "error") {
        modelSpan.setStatus({ code: SpanStatusCode.ERROR, message: outbound.error });
      } else {
        modelSpan.setStatus({ code: SpanStatusCode.OK });
      }
      // Reconstruct per-round and per-tool spans from the captured
      // block stream BEFORE we end `model.turn`, so the child spans
      // close while `modelSpan` is still recording. Pure-function;
      // any unexpected shape in `blocks` produces no spans rather
      // than blowing up the turn.
      const turnCtx = this.currentTurnCtx;
      if (turnCtx) {
        try {
          translateTurnSpans({
            blocks: sink.blocks,
            modelSpan,
            turnCtx,
            modelTurnStartMs: sink.modelTurnStartMs,
            terminalTsMs: Date.now(),
            romeAttrs: sink.romeAttrs,
          });
        } catch (err) {
          log.warn("turn-span translator threw", {
            error: err instanceof Error ? err.message : String(err),
            sessionId: this.sessionId,
            turnId: sink.turnId,
          });
        }
      }
      modelSpan.end();
      this.currentModelSpan = null;
    }
    // End the agent span here too so the trace contract is complete
    // before consumers' for-await loops drain. runOneTurn's finally
    // path is idempotent against this.
    const agentSpan = this.currentAgentSpan;
    if (agentSpan) {
      agentSpan.setAttributes({
        "session.is_new": this.isNewSession,
        tool_call_count: this.currentTurnToolCallCount,
        skill_written: this.currentTurnSkillWritten,
      });
      if (outbound.type === "error") {
        agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: outbound.error });
      } else {
        agentSpan.setStatus({ code: SpanStatusCode.OK });
      }
      agentSpan.end();
      this.currentAgentSpan = null;
      sessionDurationMetric().record(Date.now() - this.currentTurnStartMs, {
        "agent.name": this.key.agentName,
      });
    }
    this.currentTurnCtx = null;
  }

  private finalizeTurn(sink: TurnSink, terminal: ResultMessage | ErrorMessage): void {
    if (this.currentSink === sink) {
      this.finalizeTurnSpans(sink, terminal);
    }
    this.publishTurnEnd(sink, terminal);
    this.dispatchTurnFinished(sink, terminal);
    this.closeSink(sink);
  }

  /**
   * Terminate a turn on a failure path: publish the error block, then bracket
   * and close the turn.
   */
  private failTurn(sink: TurnSink, error: string | ModelResolutionErrorPayload): void {
    const terminal: ErrorMessage =
      typeof error === "string" ? { type: "error", error } : { type: "error", ...error };
    this.ensureTurnStart(sink);
    this.publishOutbound(sink, terminal);
    this.finalizeTurn(sink, terminal);
  }

  private providerInfoStored = false;

  private async maybePersistTurnCheckpoint(session: ModelSession, turnId: string): Promise<void> {
    const checkpointId = session.lastCompletedTurnCheckpoint;
    const providerThreadId = session.providerThreadId;
    if (!checkpointId || !providerThreadId) return;
    try {
      await this.deps.sessionManager.setTurnCheckpoint({
        sessionId: this.sessionId,
        turnId,
        provider: session.providerId,
        providerThreadId,
        checkpointId,
      });
    } catch (err) {
      log.warn("failed to persist provider turn checkpoint", {
        sessionId: this.sessionId,
        turnId,
        provider: session.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Persist which provider produced the successful turn, its native thread id,
   * and the concrete model that ran (the session model pin).
   */
  private async maybePersistProviderInfo(): Promise<void> {
    if (this.providerInfoStored) return;
    const identity = {
      providerId: this.modelSession.providerId,
      providerThreadId: this.modelSession.providerThreadId,
      model: this.modelSession.model,
    };
    try {
      await this.deps.sessionManager.setProviderInfo(
        this.sessionId,
        identity.providerId,
        identity.providerThreadId,
        identity.model,
      );
      this.providerInfoStored = true;
      // The pin becomes readable only once recorded: later turns of
      // this live session now resolve exactly this model, matching what a
      // cold resume of the row would do.
      this.sessionPin = { providerId: identity.providerId, model: identity.model };
    } catch (err) {
      log.warn("failed to persist session provider info", {
        sessionId: this.sessionId,
        provider: identity.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private publishOutbound(sink: TurnSink, msg: AgentMessage): StreamAgentMessage {
    const outbound: StreamAgentMessage = { ...msg, agent: this.key.agentName };
    this.publishToSink(sink, outbound);
    return outbound;
  }

  private publishToSink(sink: TurnSink, msg: StreamAgentMessage): void {
    if (sink.done) return;
    if (sink.resolvers.length > 0) {
      const r = sink.resolvers.shift()!;
      r({ value: msg, done: false });
    } else {
      sink.values.push(msg);
    }
    for (const sub of this.subscribers.values()) {
      try {
        sub(msg, sink.turnId);
      } catch (err) {
        log.warn("agent session subscriber threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private trackTurnMetrics(msg: AgentMessage | StreamAgentMessage): void {
    if (msg.type !== "tool_use") return;
    this.currentTurnToolCallCount++;
    if (
      (msg.tool === "Edit" || msg.tool === "Write") &&
      String((msg.input as Record<string, unknown>)?.file_path ?? "").includes("/skills/")
    ) {
      this.currentTurnSkillWritten = true;
    }
  }

  private closeSink(sink: TurnSink): void {
    if (sink.done) return;
    sink.done = true;
    while (sink.resolvers.length > 0) {
      const r = sink.resolvers.shift()!;
      r({ value: undefined as never, done: true });
    }
    if (this.currentSink === sink) {
      this.currentSink = null;
    }
    this.lastActiveAt = Date.now();
    this.status = "idle";
    this.currentTurnId = undefined;
    this.emitStatus();
    this.inputs.finish(sink.turnId);
  }

  private clearSubagentLinks(sink: TurnSink): void {
    if (sink.subagentLinksCleared) return;
    sink.subagentLinksCleared = true;
    for (const { parent } of sink.subagentExecutions.values()) {
      this.deps.activeSubagentRegistry?.clearByParent(parent);
    }
  }

  private dispatchTurnStarted(sink: TurnSink, input: AgentTurnInput): void {
    const dispatcher = this.deps.lifecycleDispatcher;
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    sink.lifecycleStartedAtMs = startedAtMs;
    sink.lifecycleStartedAt = startedAt;
    dispatcher.dispatchStarted({
      type: "agent-turn-started",
      version: 1,
      turn: createAgentTurnRef({
        sessionId: this.sessionId,
        turnId: sink.turnId,
        agentName: this.key.agentName,
        channelThreadKey: this.key.channelThreadKey,
        threadContext: sink.threadContext ?? this.threadContext,
        parent: sink.lifecycleParent,
      }),
      timing: { startedAt },
      input: {
        promptLength: input.prompt.length,
        attachmentsCount: sink.lifecycleAttachmentsCount,
      },
    });
  }

  private dispatchTurnFinished(sink: TurnSink, terminal?: StreamAgentMessage): void {
    const dispatcher = this.deps.lifecycleDispatcher;
    if (
      sink.lifecycleFinishDispatched ||
      !sink.lifecycleStartedAt ||
      sink.lifecycleStartedAtMs === undefined
    ) {
      return;
    }
    sink.lifecycleFinishDispatched = true;

    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();
    const startedAt = sink.lifecycleStartedAt ?? finishedAt;
    const durationMs =
      sink.lifecycleStartedAtMs === undefined ? 0 : finishedAtMs - sink.lifecycleStartedAtMs;
    const terminalKind =
      terminal?.type === "result" || terminal?.type === "error" ? terminal.type : undefined;
    const accounting =
      terminal && (terminal.type === "result" || terminal.type === "error")
        ? terminal.accounting
        : undefined;
    const stopReason =
      accounting?.stopReason ?? (sink.lifecycleInterrupted ? "interrupted" : undefined);
    const status = classifyAgentTurnStatus({
      terminalKind,
      stopReason,
      interrupted: sink.lifecycleInterrupted,
    });

    dispatcher.dispatchFinished({
      type: "agent-turn-finished",
      version: 1,
      turn: createAgentTurnRef({
        sessionId: this.sessionId,
        turnId: sink.turnId,
        agentName: this.key.agentName,
        channelThreadKey: this.key.channelThreadKey,
        threadContext: sink.threadContext ?? this.threadContext,
        parent: sink.lifecycleParent,
      }),
      status,
      timing: buildRequiredTiming({
        startedAt,
        finishedAt,
        durationMs,
      }),
      output: buildLifecycleOutput(terminal, status, stopReason),
      metrics: {
        toolCallCount: this.currentTurnToolCallCount,
        skillWritten: this.currentTurnSkillWritten,
      },
    });
  }

  private buildTurnEvents(sink: TurnSink): AsyncIterable<StreamAgentMessage> {
    const clearSubagentLinks = () => this.clearSubagentLinks(sink);
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<StreamAgentMessage>> {
            if (sink.values.length > 0) {
              return { value: sink.values.shift()!, done: false };
            }
            if (sink.done) {
              clearSubagentLinks();
              return { value: undefined as never, done: true };
            }
            return await new Promise<IteratorResult<StreamAgentMessage>>((resolve) => {
              sink.resolvers.push(resolve);
            });
          },
        };
      },
    };
  }

  /** Capture and publish one schema-valid handback submission per turn. */
  captureSubmittedOutput(payload: unknown): boolean {
    const turnId = this.currentTurnId;
    if (!turnId) {
      log.warn("submit_output captured outside an active turn — dropping", {
        sessionId: this.sessionId,
      });
      return false;
    }
    if (this.submittedOutputTurnId === turnId) return false;
    this.submittedOutputTurnId = turnId;
    const sink = this.currentSink;
    if (sink) {
      this.publishOutbound(sink, { type: "structured_output", payload });
    }
    return true;
  }

  async *runForkedTurn(input: ForkedAgentTurnInput): AsyncIterable<StreamAgentMessage> {
    if (this.status === "closed") {
      throw new Error(`AgentSession ${this.sessionId} is closed`);
    }
    this.activeForkedTurnCount++;
    this.lastActiveAt = Date.now();
    const mode: ForkRunMode = input.mode ?? "isolated";
    // Forked turns bracket their stream like regular turns; the ids are
    // minted here because no sendTurn is involved. No per-turn session_init
    // is synthesized: that re-emission is an ordinary-turn compatibility
    // shim slated for removal (step 2 of the stream-shape cleanup), and
    // forked-stream consumers read identity off turn_start.
    const forkSessionId = uuidv4();
    const turnId = uuidv4();
    const startMs = Date.now();

    // Bracketing invariant: once turn_start is out, the stream must end
    // with a terminal block followed by turn_end — even when fork setup
    // rejects, the fork throws mid-stream, or its event stream ends without
    // a terminal. Mirror the failTurn handling of regular turns by
    // synthesizing the error terminal here.
    let forkSession: ModelSession | undefined;
    let disposeForkResources: (() => Promise<void>) | undefined;
    let status: "completed" | "interrupted" | "error" = "completed";
    let terminalSeen = false;
    let outputSchemaSuspended = false;
    try {
      // Enter the cleanup scope before publishing turn_start. If a caller
      // detaches immediately after that first event, iterator.return() must
      // still release the source-session lease below.
      yield {
        type: "turn_start",
        turnId,
        sessionId: forkSessionId,
        userPrompt: input.prompt,
        agent: this.key.agentName,
      };
      try {
        // An interrupt may close the provider query while leaving the Rome
        // session reusable. Ordinary turns reopen that provider at their mutex
        // boundary; forks need the same gate before touching the source. Keep
        // the lock only through descriptor creation so the independent fork
        // does not block later source turns.
        const { fork, forkOpen, outbound } = await this.turnMutex.runExclusive(async () => {
          if (this.status === "closed") {
            throw new Error(`AgentSession ${this.sessionId} is closed`);
          }
          await this.ensureModelSessionForTurn();
          const sourceModelSession = this.modelSession;
          if (input.sourceCheckpoint) {
            if (input.sourceCheckpoint.providerId !== sourceModelSession.providerId) {
              throw new Error(
                `Fork checkpoint provider ${input.sourceCheckpoint.providerId} does not match live provider ${sourceModelSession.providerId}`,
              );
            }
            const liveProviderThreadId = sourceModelSession.providerThreadId;
            if (
              liveProviderThreadId &&
              input.sourceCheckpoint.providerThreadId !== liveProviderThreadId
            ) {
              throw new Error("Fork checkpoint belongs to a different provider thread");
            }
          }
          const forkModel = input.tier
            ? await this.deps.modelResolver.getModelProvider({
                tier: input.tier,
                providerId: sourceModelSession.providerId,
              })
            : undefined;
          const fork = await sourceModelSession.fork({
            sessionId: forkSessionId,
            mode: "ephemeral",
            configurationMode: mode,
            sourceCheckpoint: input.sourceCheckpoint?.checkpointId,
          });
          // One serialized outbound stream for the whole forked turn: the
          // provider-event pump below and out-of-band emitters (exact-mode
          // subagent relays and handback candidates) push concurrently; the drain
          // loop yields in arrival order. A provider stream failure becomes the
          // turn's terminal error block, preserving the bracketing invariant.
          const outbound = new ForkStreamQueue();
          const forkOpen = this.buildForkOpenParams({
            mode,
            forkSessionId,
            forkTurnId: turnId,
            model: forkModel?.model ?? sourceModelSession.model,
            threadContext: input.threadContext,
            emit: (msg) => outbound.push(msg),
          });
          return { fork, forkOpen, outbound };
        });
        disposeForkResources = forkOpen.dispose;
        forkSession = await fork.open(forkOpen.params);
        await forkSession.sendUserInput({
          text: input.prompt,
          reasoningEffort: input.reasoningEffort,
        });
        const providerEvents = forkSession.events;
        void (async () => {
          try {
            for await (const msg of providerEvents) {
              const projected = await forkOpen.projectProviderMessage(msg);
              for (const event of projected) outbound.push(event);
              if (projected.some(isTerminalBlock)) break;
            }
          } catch (err) {
            outbound.push({
              type: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
          outbound.end();
        })();
        for await (const msg of outbound) {
          if (
            this.structuredOutputValidator &&
            msg.type === "tool_result" &&
            toolResultSuspendsTurn(msg.output)
          ) {
            outputSchemaSuspended = true;
          }
          const out = validateProviderStructuredResult(
            msg,
            this.structuredOutputValidator,
            outputSchemaSuspended,
          );
          const projectedOut = out as StreamAgentMessage;
          // Relayed subagent blocks carry the child's agent tag; everything
          // else is this agent's own output.
          yield { ...projectedOut, agent: projectedOut.agent ?? this.key.agentName };
          if (isTerminalBlock(out)) {
            status =
              out.accounting?.stopReason === "interrupted"
                ? "interrupted"
                : out.type === "error"
                  ? "error"
                  : "completed";
            terminalSeen = true;
            break;
          }
        }
        if (!terminalSeen) {
          status = "error";
          yield {
            type: "error",
            error: "Forked turn stream ended without a terminal block",
            agent: this.key.agentName,
          };
        }
      } catch (err) {
        status = "error";
        yield {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
          agent: this.key.agentName,
        };
      }
      yield {
        type: "turn_end",
        turnId,
        status,
        durationMs: Date.now() - startMs,
        agent: this.key.agentName,
      };
    } finally {
      // Best-effort: turn_end is the stream's true terminal, so a close-time
      // rejection must not escape to the consumer (and this finally also
      // runs when the consumer abandons the iterator early).
      if (forkSession) {
        try {
          await forkSession.close();
        } catch (err) {
          log.warn("forked session close failed", {
            sessionId: this.sessionId,
            forkSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Fork-owned subagent children must not outlive the forked turn (they
      // live in a per-fork manager the source never sees — see
      // buildForkOpenParams).
      if (disposeForkResources) {
        try {
          await disposeForkResources();
        } catch (err) {
          log.warn("forked session child cleanup failed", {
            sessionId: this.sessionId,
            forkSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.activeForkedTurnCount = Math.max(0, this.activeForkedTurnCount - 1);
      this.lastActiveAt = Date.now();
      this.emitStatus();
      try {
        await this.deps.sessionManager.touchSession(this.sessionId);
      } catch (err) {
        log.warn("failed to touch source session after fork", {
          sessionId: this.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  addSubagentExecution(toolUseId: string, execution: SubagentExecution): void {
    const sink = this.currentSink;
    if (!sink) throw new Error("Cannot attach a subagent without an active Parent turn");
    sink.subagentExecutions.set(toolUseId, {
      parent: { sessionId: this.sessionId, turnId: sink.turnId, toolUseId },
      execution,
    });
    this.maybePublishSubagentStart(sink, toolUseId);
  }

  private maybePublishSubagentStart(sink: TurnSink, toolUseId: string): void {
    if (sink.emittedSubagentStarts.has(toolUseId)) return;
    const use = sink.pendingSubagentToolUses.get(toolUseId);
    const linked = sink.subagentExecutions.get(toolUseId);
    if (!use || !linked) return;
    sink.emittedSubagentStarts.add(toolUseId);
    sink.pendingSubagentToolUses.delete(toolUseId);
    this.publishOutbound(sink, {
      type: "subagent_start",
      toolUseId,
      agentName: linked.execution.agentName,
      input: use.input,
      sessionId: linked.execution.sessionId,
      turnId: linked.execution.turnId,
      ...(use.startedAt ? { startedAt: use.startedAt } : {}),
    });
  }

  // sendTurn — FIFO-serialized via turnMutex

  submitInput(
    input: AgentTurnInput & { inputId: string },
    options: SubmitInputOptions,
  ): AgentInputReceipt {
    if (this.status === "closed") throw new Error(`AgentSession ${this.sessionId} is closed`);
    return this.inputs.submit(input, options);
  }

  sendTurn(input: AgentTurnInput, options?: SendTurnOptions): AgentTurnHandle {
    if (this.status === "closed") {
      throw new Error(`AgentSession ${this.sessionId} is closed`);
    }
    // turnId is allocated here, at the bottom of the agent
    // stack, and threaded back to every consumer (route, tracing, IPC stream
    // channel name). No upper layer ever invents one — eliminates duplicate
    // / collision concerns by construction.
    const turnId = uuidv4();
    const sink: TurnSink = {
      turnId,
      userPrompt: input.prompt,
      turnStartEmitted: false,
      values: [],
      resolvers: [],
      done: false,
      blocks: [],
      modelTurnStartMs: 0,
      ttftRecorded: false,
      romeAttrs: {},
      lifecycleParent: options?.lifecycleParent,
      lifecycleAttachmentsCount: options?.attachmentsCount,
      threadContext: options?.threadContext,
      sharedContext: options?.sharedContext,
      romeSessionId: options?.romeSessionId ?? this.sessionId,
      romeSessionType:
        options?.romeSessionType ??
        (options?.threadContext?.channel === "webchat"
          ? "webchat"
          : options?.threadContext
            ? "channel"
            : "action"),
      replyTo: options?.replyTo,
      initiatedBy: options?.initiatedBy ?? "user",
      lifecycleFinishDispatched: false,
      lifecycleInterrupted: false,
      subagentExecutions: new Map(),
      pendingSubagentToolUses: new Map(),
      emittedSubagentStarts: new Set(),
      subagentLinksCleared: false,
      outputSchemaSuspended: false,
    };
    const events = this.buildTurnEvents(sink);

    // Open the per-turn `agent:*` root span here (not inside runOneTurn) so
    // it spans the turnMutex async seam — external callers can then wrap
    // post-turn work in `context.with(handle.turnContext, …)` and have it
    // land on the same trace. `links` carries an inbound request span when
    // sendTurn is invoked with no active OTel context (the webchat POST
    // case); when invoked inside one (channel adapter path), that span
    // becomes the parent.
    const channelName = this.key.channelThreadKey
      ? getChannelFromThreadKey(this.key.channelThreadKey) || undefined
      : undefined;

    // Identifying attrs stamped on every span this turn creates. We pass
    // them explicitly at each span-creation site (rather than via W3C
    // baggage on the context) so they never escape into outbound HTTP
    // headers the way baggage does under the default propagator.
    const romeAttrs: Attributes = {
      "agent.name": this.key.agentName,
      "session.id": this.sessionId,
      "turn.id": turnId,
      ...(this.key.channelThreadKey ? { "channel.thread_key": this.key.channelThreadKey } : {}),
      ...(channelName ? { "channel.name": channelName } : {}),
    };
    sink.romeAttrs = romeAttrs;

    const span = getTracer("rome").startSpan(`agent:${this.key.agentName}`, {
      attributes: {
        ...romeAttrs,
        "agent.tier": this.config.tier,
        "prompt.length": input.prompt.length,
      },
      links: options?.links,
    });
    const turnCtx = trace.setSpan(context.active(), span);

    // Hand the turn off to the per-session FIFO turn mutex. Real work
    // (publishing session_init, sending user input, awaiting result) runs
    // asynchronously in `runOneTurn`; the events iterable above stays empty
    // until then. Caller can already read `turnId` synchronously. The callback
    // swallows its own failures, so `runExclusive` never rejects here — the
    // fire-and-forget promise is intentionally discarded.
    void this.turnMutex
      .runExclusive(
        async () => {
          try {
            await context.with(turnCtx, () => this.runOneTurn(turnId, input, sink, turnCtx));
          } catch (err) {
            // Safety net: if runOneTurn threw before reaching its own finally
            // (e.g. synchronous failure before the modelSession call), the
            // agent span may still be open. End it so the trace closes.
            if (!span.isRecording || span.isRecording()) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: err instanceof Error ? err.message : String(err),
              });
              if (err instanceof Error) span.recordException(err);
              span.end();
            }
            // Surface failure on the sink so consumers' for-await ends cleanly.
            this.failTurn(
              sink,
              toModelResolutionErrorPayload(err) ??
                (err instanceof Error ? err.message : String(err)),
            );
          }
        },
        input.inputId ? 1 : 0,
      )
      .finally(() => this.emitStatus());

    return {
      turnId,
      events,
      interrupt: async (reason) => {
        if (sink.done) return;
        sink.lifecycleInterrupted = true;
        if (this.currentSink === sink) await this.interrupt(reason);
      },
      turnContext: turnCtx,
    };
  }

  private async runOneTurn(
    turnId: string,
    input: AgentTurnInput,
    sink: TurnSink,
    turnCtx: Context,
  ): Promise<void> {
    const span = trace.getSpan(turnCtx)!;
    if (this.status === "closed") {
      // sendTurn opened the span before this check could run; close it
      // here since no other path on this branch will.
      span.setStatus({ code: SpanStatusCode.ERROR, message: "AgentSession closed" });
      span.end();
      this.failTurn(sink, "AgentSession closed");
      return;
    }
    // Turns are FIFO-serialized by turnMutex. Resolve exactly once at this
    // boundary, before the sink is attached, so a backend replacement cannot
    // leak close events into the new turn.
    if (!sink.lifecycleInterrupted) await this.ensureModelSessionForTurn();
    if (sink.lifecycleInterrupted) {
      await this.modelSession.interrupt("user-stop");
      this.ensureTurnStart(sink);
      this.finalizeTurn(sink, { type: "result", content: "" });
      span.end();
      return;
    }
    this.currentSink = sink;
    this.currentTurnId = turnId;
    this.status = "running";
    this.emitStatus();

    this.currentAgentSpan = span;
    this.currentTurnCtx = turnCtx;

    // Reset per-turn counters; final values are stamped on the agent span
    // when the events loop observes the terminal result/error message.
    this.currentTurnToolCallCount = 0;
    this.currentTurnSkillWritten = false;
    this.currentTurnStartMs = Date.now();
    this.dispatchTurnStarted(sink, input);

    // `model.turn` aggregates the whole SDK query() for this turn — accounting
    // attrs (tokens/cost/num_turns/stop_reason) are stamped on it when the
    // terminal result lands. Per-round detail (one `model.round` child span
    // per agent-loop iteration, one `tool` grandchild per tool_use ↔
    // tool_result pair) is reconstructed from the captured block stream by
    // `translateTurnSpans` at terminal time (see runEventsLoop). Built
    // in-process rather than relying on the SDK's `claude_code.*` spans
    // because the pinned SDK version doesn't reliably emit them.
    sink.modelTurnStartMs = Date.now();
    const modelSpan = context.with(turnCtx, () =>
      startRomeSpan("model.turn", {
        ...sink.romeAttrs,
        "model.id": this.modelSession.model,
        "system_prompt.length": this.systemPrompt.length,
        tool_count: this.toolCount,
      }),
    );
    this.currentModelSpan = modelSpan;

    try {
      // turn_start is the first event of the turn's stream: trace builders
      // reset the previous turn's summary on it, so nothing of turn N+1
      // (including the per-turn session_init below) may become visible while
      // the summary still shows turn N's terminal state.
      this.ensureTurnStart(sink);
      // Per-turn session_init: trace/UI headers (AgentCallBlock, showcases'
      // userPrompt derivation) still key off it. Step 2 of the stream-shape
      // cleanup demotes it to once-per-session — turn_start above is already
      // the authoritative turn boundary.
      const tc = sink.threadContext ?? this.threadContext;
      // Thread + project framing lives on the FIRST user message of a fresh
      // conversation (a `<thread_context>` block), not the system prompt, so the
      // cached system prefix stays identical across sessions. Gated to a new,
      // non-subagent session's first turn: a resumed session already carries the
      // block in its provider history (re-injecting would duplicate it), and
      // subagents get no such framing (they get no contextSuffix either). The
      // one-shot flag flips here regardless — if a brand-new session's first turn
      // short-circuits (e.g. the not-logged-in gate) we don't carry it forward;
      // that path means Rome isn't usable yet, so the loss is benign.
      let userPrompt = input.prompt;
      let pendingConversationMessageIds: string[] = [];
      if (this.deps.webchatRepo && sink.romeSessionType === "channel" && sink.romeSessionId) {
        const storedContext = await this.deps.webchatRepo.loadConversationContext(
          sink.romeSessionId,
          sink.replyTo?.messageId,
        );
        const conversationContext =
          storedContext.repliedTo || !sink.replyTo?.content
            ? storedContext
            : {
                ...storedContext,
                repliedTo: {
                  id: `runtime-reply:${sink.replyTo.messageId}`,
                  content: JSON.stringify([{ type: "text", content: sink.replyTo.content }]),
                  senderName: sink.replyTo.senderName ?? null,
                },
              };
        pendingConversationMessageIds = storedContext.pendingNotificationIds;
        userPrompt = prependConversationContext(userPrompt, conversationContext);
      }
      if (!this.isSubagent && this.isNewSession && !this.threadContextInjected && tc) {
        this.threadContextInjected = true;
        const block = buildThreadContextBlock(tc, this.workingDir);
        if (block) {
          userPrompt = `${block}\n\n${userPrompt}`;
        }
      }
      const initMsg: AgentMessage = {
        type: "session_init",
        sessionId: this.sessionId,
        romeSession: {
          _romeSessionId: sink.romeSessionId,
          _type: sink.romeSessionType,
        } satisfies RomeSessionRef,
        systemPrompt: this.systemPrompt,
        userPrompt,
        projectPath: tc?.projectPath,
        turnId,
      };
      this.publishOutbound(sink, initMsg);

      // Turn-middleware onion. App middlewares wrap the act of
      // producing this turn's reply; the real model call is fixed innermost and runs only when every
      // middleware calls next(). A middleware that short-circuits — e.g.
      // welcome-to-rome's scripted conversation — emits its own model-isomorphic
      // content events via ctx.emit and the model is never touched. Bracketing
      // (turn_start/turn_end) and status stay on this wrapper, so a scripted
      // turn closes exactly like a model turn and the downstream SSE/persistence
      // pipeline can't tell them apart.
      const mwInput = { prompt: userPrompt, reasoningEffort: input.reasoningEffort };
      let emittedTerminal: ResultMessage | ErrorMessage | undefined;
      let modelRan = false;
      const mwCtx: TurnMiddlewareContext = {
        input: mwInput,
        session: {
          id: this.sessionId,
          agentName: this.key.agentName,
          channelThreadKey: this.key.channelThreadKey,
        },
        emit: (event) => {
          if (sink.done) return;
          if (
            this.structuredOutputValidator &&
            event.type === "tool_result" &&
            toolResultSuspendsTurn(event.output)
          ) {
            sink.outputSchemaSuspended = true;
          }
          const outbound = validateProviderStructuredResult(
            event,
            this.structuredOutputValidator,
            sink.outputSchemaSuspended,
          );
          if (outbound.type === "result" || outbound.type === "error") {
            emittedTerminal = outbound;
          }
          this.publishOutbound(sink, outbound);
        },
        meta: {},
      };

      const runModelTerminal = async (): Promise<void> => {
        if (sink.done) return;
        if (sink.lifecycleInterrupted) {
          await this.modelSession.interrupt("user-stop");
          this.finalizeTurn(sink, { type: "result", content: "" });
          return;
        }
        modelRan = true;
        try {
          await context.with(turnCtx, async () => {
            await this.inputs.beforeSend(turnId);
            await this.modelSession.sendUserInput({
              inputId: input.inputId,
              text: mwInput.prompt,
              images: input.images,
              reasoningEffort: mwInput.reasoningEffort,
              injectedToolResult: input.injectedToolResult,
            });
            this.inputs.ready(turnId);
            if (this.deps.webchatRepo && pendingConversationMessageIds.length > 0) {
              try {
                await this.deps.webchatRepo.markConversationContextInjected(
                  pendingConversationMessageIds,
                  sink.turnId,
                );
              } catch (err) {
                // Provider dispatch already succeeded. Keep the turn alive and
                // leave rows pending so a later turn can safely retry context.
                log.warn("failed to mark conversation context injected", {
                  romeSessionId: sink.romeSessionId,
                  turnId: sink.turnId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          });
        } catch (err) {
          // Provider failed before completing the turn (e.g. mock that throws,
          // or a real SDK transport error). Close the sink with a synthetic
          // error so the consumer's iterator terminates cleanly.
          this.failTurn(sink, err instanceof Error ? err.message : String(err));
        }

        // Wait for sink to close (events loop closes on `result`/`error`).
        await new Promise<void>((resolve) => {
          const checker = setInterval(() => {
            if (sink.done) {
              clearInterval(checker);
              resolve();
            }
          }, 5);
        });
      };

      const chain = this.deps.turnMiddleware;
      if (chain) {
        await chain.run(mwCtx, runModelTerminal);
      } else {
        await runModelTerminal();
      }

      if (!sink.done) {
        if (!modelRan && input.inputId) {
          await this.inputs.observe(
            {
              type: "input_status",
              inputId: input.inputId,
              state: emittedTerminal?.type === "error" ? "failed" : "consumed",
            },
            turnId,
          );
        }
        let terminal: ResultMessage | ErrorMessage = emittedTerminal ?? {
          type: "result",
          content: "",
        };
        if (!emittedTerminal && this.structuredOutputValidator) {
          terminal = validateProviderStructuredResult(
            terminal,
            this.structuredOutputValidator,
            sink.outputSchemaSuspended,
          ) as ResultMessage | ErrorMessage;
          this.publishOutbound(sink, terminal);
        }
        this.finalizeTurn(sink, terminal);
      }

      // The agent + model spans are normally ended by runEventsLoop on the
      // terminal `result`/`error` message. If we still hold them here, the
      // events loop never observed a terminal — close them as a safety net.
      if (this.currentAgentSpan === span) {
        span.setAttributes({
          "session.is_new": this.isNewSession,
          tool_call_count: this.currentTurnToolCallCount,
          skill_written: this.currentTurnSkillWritten,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        this.currentAgentSpan = null;
        sessionDurationMetric().record(Date.now() - this.currentTurnStartMs, {
          "agent.name": this.key.agentName,
        });
      }
      if (this.currentModelSpan === modelSpan) {
        modelSpan.end();
        this.currentModelSpan = null;
      }
      this.currentTurnCtx = null;

      if (!this.keepAlive) {
        // Phase 3: close on every turn boundary; Phase 4 flips this.
        await this.close("user");
      }
    } catch (err) {
      if (this.currentAgentSpan === span) {
        span.setAttributes({
          "session.is_new": this.isNewSession,
          tool_call_count: this.currentTurnToolCallCount,
          skill_written: this.currentTurnSkillWritten,
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        if (err instanceof Error) span.recordException(err);
        span.end();
        this.currentAgentSpan = null;
      }
      if (this.currentModelSpan === modelSpan) {
        modelSpan.end();
        this.currentModelSpan = null;
      }
      this.currentTurnCtx = null;
      throw err;
    }
  }

  subscribe(handler: AgentSessionSubscriber): () => void {
    const id = uuidv4();
    this.subscribers.set(id, handler);
    return () => {
      this.subscribers.delete(id);
    };
  }

  onStatusChange(listener: AgentSessionStatusListener): () => void {
    const id = uuidv4();
    this.statusListeners.set(id, listener);
    // Fire current status immediately for late subscribers.
    try {
      listener({
        key: this.key,
        sessionId: this.sessionId,
        status: this.status,
        turnId: this.currentTurnId,
      });
    } catch {
      // ignore
    }
    return () => {
      this.statusListeners.delete(id);
    };
  }

  private emitStatus(): void {
    const event: AgentSessionStatusEvent = {
      key: this.key,
      sessionId: this.sessionId,
      status: this.status,
      turnId: this.currentTurnId,
    };
    for (const l of this.statusListeners.values()) {
      try {
        l(event);
      } catch {
        // ignore
      }
    }
  }

  async interrupt(reason?: string, expectedTurnId?: string): Promise<void> {
    const sink = this.currentSink;
    if (!sink || sink.done || (expectedTurnId && sink.turnId !== expectedTurnId)) return;
    sink.lifecycleInterrupted = true;
    // Cancel the provider before awaiting child cleanup. A slow child must
    // not keep its parent generating after the user presses Stop.
    await Promise.all([
      this.modelSession.interrupt(reason),
      Promise.allSettled(
        [...sink.subagentExecutions.values()].map(({ execution }) => execution.interrupt(reason)),
      ),
    ]);
  }

  async close(reason: "idle" | "shutdown" | "error" | "user"): Promise<void> {
    if (this.closingPromise) return await this.closingPromise;
    if (this.status === "closed") return;
    this.inputs.close();
    this.closingPromise = (async () => {
      log.info("agent session closing", {
        sessionId: this.sessionId,
        agentName: this.key.agentName,
        reason,
      });
      const currentSink = this.currentSink;
      if (currentSink) {
        await Promise.allSettled(
          [...currentSink.subagentExecutions.values()].map(({ execution }) =>
            execution.interrupt(`Parent session closed: ${reason}`),
          ),
        );
      }
      try {
        await this.modelSession.close();
      } catch (err) {
        log.warn("modelSession close threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.status = "closed";
      this.emitStatus();
      if (currentSink) {
        this.clearSubagentLinks(currentSink);
      }
      if (this._childManager) {
        try {
          await this._childManager.shutdown();
        } catch {
          // best-effort
        }
      }
      this.onClosed();
    })();
    await this.closingPromise;
  }
}

// Helpers

function buildSubagentTools(
  agentLoader: AgentLoader,
  config: ReturnType<AgentLoader["get"]>,
): { tools: ModelToolDefinition[]; targets: Map<string, string> } {
  if (!config.allowedSubagents || config.allowedSubagents.length === 0) {
    return { tools: [], targets: new Map() };
  }
  const targets = new Map<string, string>();
  const tools = config.allowedSubagents.map((subagentName) => {
    const subConfig = agentLoader.get(subagentName);
    const toolName = subagentName.includes(":")
      ? `sa_${createHash("sha256").update(subagentName).digest("hex").slice(0, 16)}`
      : subagentName;
    targets.set(toolName, subagentName);
    return {
      name: toolName,
      description: `Delegate a task to the "${subagentName}" subagent: ${subConfig.description}`,
      inputSchema: {
        properties: {
          prompt: {
            type: "string",
            description: "The task/prompt to send to the subagent",
          },
          resumeSessionId: {
            type: "string",
            description: "Explicit Child session ID to resume; omitted starts a fresh session",
          },
        },
        required: ["prompt"],
      },
    };
  });
  return { tools, targets };
}

function buildLifecycleOutput(
  terminal: StreamAgentMessage | undefined,
  status: AgentTurnStatus,
  stopReason: string | undefined,
): AgentTurnOutput {
  if (terminal?.type === "result") {
    return {
      text: terminal.content,
      structuredOutput: terminal.structuredOutput,
      state: status === "interrupted" ? "partial" : "final",
      terminalKind: "result",
      stopReason,
      accounting: terminal.accounting,
    };
  }
  if (terminal?.type === "error") {
    return {
      text: "",
      state: "none",
      terminalKind: "error",
      stopReason,
      error: terminal.error,
      accounting: terminal.accounting,
    };
  }
  return {
    text: "",
    state: "none",
    stopReason,
  };
}

// Re-export type aliases for convenience.
export type { StreamAgentMessage };
export type { AgentMessage };
