// Long-lived, serialized agent sessions. Session model: docs/concepts/sessions.md.

import { mkdir, stat } from "node:fs/promises";
import { Mutex } from "async-mutex";
import {
  AgentInputQueue,
  type AgentInputReceipt,
  SUPERSEDED_INTERRUPT_REASON,
  type SubmitOptions,
} from "./agent-input-queue.js";
import { afterLanding, isQueueInput } from "../domain/input-queue.js";
import { v4 as uuidv4, v7 as uuidv7 } from "uuid";
import {
  requireAgent,
  type AgentCatalog,
  type AgentDefinition,
} from "../domain/agent-definition.js";
import { storeForkParent } from "../domain/session-parent.js";
import { turnStatus, type TurnEnding } from "../domain/turn-end.js";
import { createTurn, type Turn, type TurnWriter } from "../domain/turn.js";
import { endedTurn, type TurnLifecycle } from "../domain/turn-lifecycle.js";
import type { TurnMiddleware } from "../domain/turn-middleware.js";
import { shapedResult, type AnswerShape, type ReadAnswerShape } from "../domain/answer-shape.js";
import { type TurnAttribution, type TurnUsageReporting } from "../domain/turn-usage-reporting.js";
import { type SessionSettings, restoresSavedSelection } from "../domain/session-settings.js";
import { evaluateProviderSessionReset } from "../domain/session-reset.js";
import { type AgentFolders, projectPath } from "../domain/agent-folders.js";
import { catchUpPrompt } from "../domain/catch-up.js";
import { type PromptFacts, type PromptMessage } from "../domain/prompt-facts.js";
import { type AgentLog } from "../domain/agent-log.js";
import { type DeferTool } from "./ask-user-tools.js";
import { type SessionTools, forkSessionTools } from "../domain/session-tools.js";
import { type ForkOpening, type ForkRequest, keepsFork, openFork } from "../domain/fork.js";
import { type TurnFacts, type PushLevel } from "../domain/turn-facts.js";
import {
  NO_ROME_TOOLS,
  type RomeTool,
  type RomeToolDefinition,
  type RomeTools,
  type ModelToolCallContext,
} from "../domain/rome-tools.js";
import { Session, type SessionKind } from "../domain/session.js";
import {
  type ModelSessionEvent,
  type ModelTurnStartedEvent,
  type ModelPosition,
  type ModelProvider,
  type ThreadStart,
  type McpServerConfig,
  type ModelSession,
  type ModelSessionParams,
  type ModelReasoningEffort,
  type ProviderId,
} from "../domain/model-port.js";
import { type SessionRepository } from "../domain/session-repository.js";
import { type Skill, type SkillCatalog } from "../domain/skill.js";
import { type SystemPrompts } from "./system-prompts.js";
import {
  buildContinuationBlock,
  buildDeviceFolderBlock,
  buildThreadContextBlock,
  FETCH_CHANNEL_HISTORY_ACTION,
} from "../domain/prompt.js";
import { resolveAgentPolicy } from "../domain/agent-policy.js";
import { createRomeTools } from "./rome-tools.js";
import { showsWidgets, widgetDrawingFor } from "../domain/widget-drawing.js";
import { type AgentAction, type AgentActions } from "../domain/agent-action.js";
import { type WakeUp } from "../domain/defer.js";
import { subagentToolName, type Subagent } from "../domain/subagent.js";
import { type ModelTier } from "../domain/model-tier.js";
import { modelResolutionRequest } from "../domain/model-resolution.js";
import {
  toModelResolutionErrorPayload,
  type ModelResolution,
  type ModelResolutionErrorPayload,
  type ModelResolver,
} from "./model-resolver.js";
import { type ModelLoginKind } from "../domain/model-login.js";
import { type ModelSelectionId } from "../domain/model-selection.js";
import { isTerminalEvent, isTransientDelta } from "../domain/turn-events.js";
import {
  buildRequiredTiming,
  createAgentTurnRef,
  type AgentTurnParentRef,
} from "../domain/turn-ref.js";
import type {
  AgentEvent,
  ThreadContext,
  AgentTurnStatus,
  TurnErrorEvent,
  MessageReplyReference,
  TurnResultEvent,
  RomeSessionRef,
  RomeSessionType,
  StreamAgentEvent,
  ProviderSessionResetPolicy,
} from "@rome-os/app-runtime";
import { createNullModelSession } from "./null-model-session.js";
import type { SessionTracing } from "./session-tracing.js";
import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span,
} from "@opentelemetry/api";
import { subagentRequest } from "../domain/subagent.js";
import type {
  SubagentCall,
  SubagentCallKey,
  SubagentCalls,
  SubagentSessions,
} from "./subagent-calls.js";
import { translateTurnSpans, type CapturedEvent } from "./turn-spans.js";
import { createTurnsById, type TurnsById } from "./turns-by-id.js";
import { KeyedMutex } from "../../lib/keyed-mutex.js";

export interface AgentSessionKey {
  agentName: string;
  /** e.g. `webchat:<id>`, `telegram:<chatId>`, `sentinel:<channel>:<thread>`. */
  channelThreadKey: string;
}

/** What an opener states about the session it opens, fixed for the session's life
 *  unless a field says otherwise. */
export interface SessionOpening {
  /**
   * What the session serves: a conversation, or an action. Absent, a session
   * opened with a thread context serves a conversation and any other an
   * action. A subagent's and a fork's session are their own kinds.
   */
  kind?: Extract<SessionKind, "conversation" | "action">;
  workingDir?: string;
  threadContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
  /**
   * Set by `AgentSessionBridge` for runs that reach the top-level manager over
   * the worker→main RPC — i.e. an action spawning an agent (blocking `summon`),
   * which is a nested subagent run by construction. Used only for the
   * `rome.session.acquire` metric's `is_subagent` label; it does NOT change
   * session behavior (login-notice gating, defer, etc. still key off the
   * manager-level `isSubagent`, which is false for the top-level manager).
   */
  isSubagent?: boolean;
  /** Appended to the system prompt at open time. */
  contextSuffix?: string;
  /**
   * Optional exact model selection, used by the WebChat model selector. On a
   * session that is already open, a value replaces its selection from the next
   * turn and null clears it; undefined leaves it as it is.
   */
  selectionId?: ModelSelectionId | null;
  reasoningEffort?: ModelReasoningEffort;
  /**
   * The reset policy of the chat whose message this acquire answers, which
   * the opener read from Chat settings. Given, a session that is due for a
   * reset under it is replaced before it opens.
   */
  resetPolicy?: ProviderSessionResetPolicy;
  /**
   * The conversation the session opens in shows interactive cards, so its
   * agent may pause on one for a human reply. Fixed for the session's life,
   * since it shapes the cached system prompt. Absent, it shows none.
   */
  drawsCards?: boolean;
  /**
   * The session's conversation faces the guardian, so a wake-up can be
   * scheduled back into it. Absent, it cannot.
   */
  guardianFacing?: boolean;
  /**
   * Name-value pairs the model session's tools run with; a name given no
   * value is cleared. The session passes them through. Absent, the tools run
   * with Rome's own environment, so every opener states it.
   */
  toolEnv?: Record<string, string | undefined>;
  /** Attributes stamped on the spans of every turn. The session passes them through. */
  spanAttributes?: Attributes;
}

/** What a resume states. It carries no reset policy, since a session named by
 *  id is resumed as it is. */
export type ResumeOpening = Omit<SessionOpening, "resetPolicy">;

/** An open as `Sessions` serves it: what the opener states, and the stored
 *  session it names by id, if any. */
type OpenRequest = SessionOpening & { resumeSessionId?: string };

export interface AgentTurnInput {
  inputId?: string;
  prompt: string;
  /** Absolute local paths of images attached to the turn (providers without image-input support ignore them). */
  images?: string[];
  reasoningEffort?: ModelReasoningEffort;
}

/** A forked turn: what it says, and what the fork asks of its source (see `openFork`). */
export interface ForkedAgentTurnInput extends AgentTurnInput, ForkRequest {
  /** Optional capability tier override for the forked turn. */
  tier?: ModelTier;
}

export type AgentSessionStatus = "idle" | "running" | "closed";

/** A turn the session started, with the trace context its spans run in. */
export interface AgentTurnHandle extends Turn {
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
  threadContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
  /**
   * The dashboard chat the turn records in, when it is not the one minted
   * under the session's own id. The opener names it with each turn while
   * each turn picks its own chat (ZHA-157); it is the one exception to the
   * agent context asking Chats nothing.
   */
  romeSessionId?: string;
  /** Platform message referenced by the current ordinary reply. */
  replyTo?: MessageReplyReference;
  /** The message `replyTo` names, as Rome holds it where the turn's session
   *  stands, or null when Rome holds none. Read only with `promptFacts`. */
  quoted?: PromptMessage | null;
  initiatedBy?: "user" | "system";
  /** Pushes the first message said in the turn at this level (RunParams.pushLevel). */
  pushLevel?: PushLevel;
}

export interface AgentSessionStatusEvent {
  key: AgentSessionKey;
  sessionId: string;
  status: AgentSessionStatus;
  turnId?: string;
}

export type AgentSessionStatusListener = (event: AgentSessionStatusEvent) => void;

export interface AgentSession {
  readonly key: AgentSessionKey;
  readonly sessionId: string;
  readonly status: AgentSessionStatus;
  /** The turn the session is running, until it ends. */
  readonly runningTurn?: Turn;
  /**
   * Submits an input, by default `next`. The receipt says where it landed and
   * resolves with the turn it lands in once that turn has started. An `after`
   * input starts a turn of its own behind the running one, so its turn is
   * there when `submit` returns.
   */
  submit(input: AgentTurnInput, options?: SubmitOptions): AgentInputReceipt;
  selectModel(selectionId: ModelSelectionId | null): void;
  fork(input: ForkedAgentTurnInput): AsyncIterable<StreamAgentEvent>;
  onStatusChange(listener: AgentSessionStatusListener): () => void;
  /** Stops the session's running turn, if it has one, and the subagent calls it waits on. */
  stop(reason?: string): Promise<void>;
  close(reason: "idle" | "shutdown" | "error" | "user"): Promise<void>;
}

/** A stored session to reopen by its id, which may have no continuity key of its own to open by. */
export interface SessionById {
  id: string;
  agent: string;
}

export interface Sessions {
  /** The open session for this continuity key and agent, opening it when none is open. */
  open(continuityKey: AgentSessionKey, opening?: SessionOpening): Promise<AgentSession>;
  /**
   * The stored session with this id, reopened when it is not open. Fails when
   * no stored session has the id or the session cannot be resumed.
   */
  resume(session: SessionById, opening?: ResumeOpening): Promise<AgentSession>;
  /** The open session for this continuity key and agent. Never opens one. */
  find(continuityKey: AgentSessionKey): AgentSession | undefined;
  /**
   * Working directory of the open session with this runtime id, searching this
   * manager's sessions and the subagent sessions they own. Undefined when no
   * open session has the id. Never opens a session.
   */
  findWorkingDirBySessionId(sessionId: string): string | undefined;
  /**
   * The turn with this id, started by one of this manager's sessions or by a
   * subagent or forked session they opened. Found from its start until 30 s
   * after it ends.
   */
  turn(id: string): Turn | undefined;
  shutdown(): Promise<void>;
}

interface ManagerDeps {
  agentLoader: AgentCatalog;
  sessionRepository: SessionRepository;
  systemPrompts: SystemPrompts;
  modelResolver: ModelResolver;
  /** The actions each agent may call, run for the turn that calls them. */
  actions: AgentActions;
  /** Schedules a deferred wake back into a turn's thread. */
  defer: Pick<DeferTool, "schedule">;
  /** Where each session's own tools come from. */
  sessionTools: SessionTools;
  /** The MCP servers found on the network, served to an agent whose
   *  definition asks for network discovery. */
  networkMcpServers: () => Record<string, McpServerConfig>;
  skillCatalog: SkillCatalog;
  turnLifecycle: TurnLifecycle;
  /** Reads the answer shape an agent declares in its `outputSchema`. */
  readAnswerShape: ReadAnswerShape;
  /** What was said where each session stands that it has not seen, which a
   *  wake's catch-up reads and marks. Absent, a channel session catches up on
   *  nothing. */
  promptFacts?: PromptFacts;
  /** Answers the subagent calls a turn makes. */
  subagentCalls?: SubagentCalls;
  /** Where a calling session's subagent sessions open: its session manager,
   *  under its stored parent link, with its tools' environment and span
   *  attributes. */
  subagentSessions?: (
    manager: Sessions,
    parentLink: string,
    inherited: Pick<SessionOpening, "toolEnv" | "spanAttributes">,
  ) => SubagentSessions;
  /** The middleware apps put around a turn's reply. Absent, the model replies directly. */
  turnMiddleware?: TurnMiddleware;
  /** What each chat set for its sessions. Absent, no saved model is restored. */
  sessionSettings?: SessionSettings;
  /** Where agents work: the default working directory and the projects folder. */
  folders: AgentFolders;
  /** Where the session logs. */
  log: AgentLog;
  /** Hears how sessions are served and how every turn goes, forked turns included. */
  turnUsage: TurnUsageReporting;
  /** Stamps the session id on the spans a session starts and binds it for logs. */
  sessionTracing: SessionTracing;
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
  /** The turns of the manager that opened this one, so one lookup finds both. */
  turns?: TurnsById;
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

export function createSessions(deps: ManagerDeps, options: ManagerOptions = {}): Sessions {
  const { log } = deps;
  const sessions = new Map<string, AgentSessionImpl>();
  const acquireLocks = new Map<string, Promise<AgentSessionImpl>>();
  const lifecycleMutex = new KeyedMutex();
  const keepAlive = options.keepAliveAcrossTurns === true;
  const idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
  const isSubagent = options.isSubagent === true;
  const turns = options.turns ?? createTurnsById();

  const keyOf = (k: AgentSessionKey) => `${k.agentName}::${k.channelThreadKey}`;
  const canonicalizeKey = (key: AgentSessionKey): AgentSessionKey => ({
    ...key,
    agentName: requireAgent(deps.agentLoader, key.agentName).name,
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
    init?: OpenRequest,
    /** Set when the reset policy already ran for this acquire. */
    resetChecked?: { prepared?: Session },
  ): Promise<AgentSession> => {
    const k = keyOf(key);
    const reset = init?.resetPolicy;
    if (reset && !init.resumeSessionId && !resetChecked) {
      const interactionAt = new Date();
      const chatId = init.threadContext?.romeSessionId;
      return await lifecycleMutex.runExclusive(k, async () => {
        const active = await deps.sessionRepository.current(key.channelThreadKey, key.agentName);
        const decision = active
          ? evaluateProviderSessionReset(reset, active, interactionAt)
          : { due: false as const };
        const cached = sessions.get(k);
        if (decision.due) {
          log.info("provider_session.reset_due", {
            chatId,
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
        let prepared: Session | undefined;
        if (decision.due && active) {
          prepared = active.replace();
          await deps.sessionRepository.replace(active, prepared);
          log.info("provider_session.rotated", {
            chatId,
            agentName: key.agentName,
            provider: active.provider ?? undefined,
            oldSessionId: active.id,
            newSessionId: prepared.id,
            resetReason: decision.reason,
            policyMode: reset.mode,
            result: "succeeded",
          });
        }
        return await acquireInner(key, span, init, { prepared });
      });
    }
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
      deps.turnUsage.sessionServed(outcome, {
        agentName: key.agentName,
        isSubagent: isSubagentForMetric,
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
      } else {
        // Provider/model changes are resolved at the serialized turn boundary.
        // Reusing the Rome session here preserves its turn queue and lets the
        // session swap only the model backend when needed. A selection made
        // in the open chat applies from the next turn.
        if (init?.selectionId !== undefined) existing.selectModel(init.selectionId);
        recordAcquire("reuse");
        return existing;
      }
    }
    const current = sessions.get(k);
    if (current && current.status !== "closed") {
      if (init?.selectionId !== undefined) current.selectModel(init.selectionId);
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
      const sess = await openSession(deps, key, init ?? {}, {
        prepared: resetChecked?.prepared,
        keepAlive,
        onClosed: onSessionClosed,
        isSubagent,
        turns,
      });
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
  const acquire = (key: AgentSessionKey, init?: OpenRequest): Promise<AgentSession> => {
    const canonicalKey = canonicalizeKey(key);
    return deps.sessionTracing.withSpan(
      "session.acquire",
      { "agent.name": canonicalKey.agentName, is_subagent: init?.isSubagent ?? isSubagent },
      (span) => acquireInner(canonicalKey, span, init),
    );
  };

  const acquireBySessionId = async (
    sessionId: string,
    agentName: string,
    opening?: ResumeOpening,
  ): Promise<AgentSession> => {
    const session = await resumableSession(deps, sessionId, agentName);
    if (!session?.continuityKey) {
      throw new Error(`Agent session "${sessionId}" was not found or cannot be resumed`);
    }
    return acquire(
      { agentName, channelThreadKey: session.continuityKey },
      { ...(opening ?? {}), resumeSessionId: sessionId },
    );
  };

  return {
    open: (continuityKey, opening) => acquire(continuityKey, opening),
    resume: (session, opening) => acquireBySessionId(session.id, session.agent, opening),
    find(continuityKey) {
      let canonicalKey: AgentSessionKey;
      try {
        canonicalKey = canonicalizeKey(continuityKey);
      } catch {
        return undefined;
      }
      const sess = sessions.get(keyOf(canonicalKey));
      return sess && sess.status !== "closed" ? sess : undefined;
    },
    findWorkingDirBySessionId(sessionId) {
      for (const sess of sessions.values()) {
        if (sess.status === "closed") continue;
        if (sess.sessionId === sessionId || sess.hasActiveFork(sessionId)) {
          return sess.workingDirectory;
        }
        const nested = sess.openedChildManager?.findWorkingDirBySessionId(sessionId);
        if (nested) return nested;
      }
      return undefined;
    },
    turn: (id) => turns.find(id),
    async shutdown() {
      if (sweeperTimer) clearInterval(sweeperTimer);
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.all(all.map((s) => s.close("shutdown").catch(() => undefined)));
    },
  };
}

interface OpenOptions {
  /** The successor the reset path already wrote, which this open serves. */
  prepared?: Session;
  keepAlive: boolean;
  onClosed: (s: AgentSessionImpl) => void;
  isSubagent: boolean;
  turns: TurnsById;
}

/**
 * Identity + routing for tool executions on one logical turn owner. openSession
 * builds the execute callbacks (actions, subagents, defer)
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
   * Manager that owns this owner's subagent child sessions. The live session
   * hands out its own child manager; each exact fork gets a fork-owned manager
   * (disposed with the fork) so a fork's subagent turns never append to — or
   * create — a child session the source's turns reuse.
   */
  getChildManager: () => Sessions;
  /**
   * channelThreadKey under which this owner's children are acquired. Forks
   * namespace it with the fork session id: splitting the in-memory manager
   * alone would not stop the fork child's open from resuming the *source*
   * child's persisted session (`SessionRepository.current` matches on this
   * key), which would contaminate the same model thread the source resumes
   * later.
   */
  childChannelThreadKey: string;
  /** Attach the subagent call to this owner's provider tool call. */
  attachSubagentCall: (toolUseId: string, call: SubagentCall) => void;
  /** Bind an async tool callback into the owner's OTel context. */
  bindTurnCtx: <T>(fn: () => T) => T;
}

/** Per-fork identity handed to `buildForkOpenParams` by `fork`. */
interface ForkTurnContext {
  opening: ForkOpening;
  forkSessionId: string;
  forkTurnId: string;
  /** Model id the fork opens with (caller-resolved tier override, else the source's live model). */
  model: string;
  /**
   * Interleave an out-of-band message into the forked turn's stream.
   */
  emit: (msg: StreamAgentEvent) => void;
}

/**
 * What the open-params factory hands back to `fork`.
 */
interface ForkOpen {
  params: ModelSessionParams;
  /** Replace provider-generic subagent tool events with semantic ones. */
  projectProviderMessage: (msg: StreamAgentEvent) => Promise<StreamAgentEvent[]>;
  /**
   * Close fork-owned resources (the per-fork subagent child manager, if the
   * fork ran any subagents). `fork` calls this from its finally, so
   * fork children never outlive the forked turn.
   */
  dispose: () => Promise<void>;
}

type BuildForkOpenParams = (fork: ForkTurnContext) => Promise<ForkOpen>;

/** The default working directory, made when it is missing. */
async function ensureDefaultWorkingDir(folders: AgentFolders): Promise<string> {
  await mkdir(folders.defaultWorkingDir, { recursive: true });
  return folders.defaultWorkingDir;
}

/** The recorded dir when it still exists, else undefined. The default project is recreated. */
async function reachableRecordedWorkingDir(
  folders: AgentFolders,
  recorded: string,
): Promise<string | undefined> {
  if (recorded === folders.defaultWorkingDir) return await ensureDefaultWorkingDir(folders);
  const isDirectory = await stat(recorded).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
  return isDirectory ? recorded : undefined;
}

/**
 * The session an explicit id names, when this agent can resume it: it is
 * active, has a continuity key, and belongs to this agent under any of the
 * agent's names. An older duplicate beside a newer active session stays
 * resumable by its id, as it was.
 */
async function resumableSession(
  deps: ManagerDeps,
  sessionId: string,
  agentName: string,
): Promise<Session | undefined> {
  const session = await deps.sessionRepository.session(sessionId);
  if (!session || session.status !== "active" || session.continuityKey === null) return undefined;
  return deprecatedSameAgent(deps, session.agentName, agentName) ? session : undefined;
}

/** @deprecated Matches an agent under its legacy names, which a stored
 *  session can still carry. Goes when agent names are canonical before they
 *  reach Sessions, and this compares them as strings. */
function deprecatedSameAgent(
  deps: ManagerDeps,
  storedName: string,
  requestedName: string,
): boolean {
  if (storedName === requestedName) return true;
  const stored = deps.agentLoader.find(storedName);
  const requested = deps.agentLoader.find(requestedName);
  return stored !== undefined && requested !== undefined && stored.name === requested.name;
}

async function openSession(
  deps: ManagerDeps,
  key: AgentSessionKey,
  init: OpenRequest,
  opts: OpenOptions,
): Promise<AgentSessionImpl> {
  const { log } = deps;
  const agent = requireAgent(deps.agentLoader, key.agentName);
  const config = agent.definition;
  const owningAppId = agent.ownerType === "app" ? agent.ownerId : undefined;

  // Try to resume an existing SDK session through the stable channelThreadKey.
  // Scoping by agentName is load-bearing: subagents reuse the parent's key, so
  // without the agent filter a subagent could inherit its parent's provider
  // thread and system prompt/history.
  // The session the reset path already wrote, or the one this open resumes.
  // Neither set, this open creates one.
  let prepared = opts.prepared;
  let resumed: Session | undefined;
  if (prepared) {
    // The reset already wrote this fresh session. Keep `resumed` empty so
    // provider open and prompt framing use new-session semantics while
    // retaining the id the reset allocated.
  } else if (init.resumeSessionId) {
    resumed = await resumableSession(deps, init.resumeSessionId, key.agentName);
    if (!resumed) {
      throw new Error(`Agent session "${init.resumeSessionId}" was not found or cannot be resumed`);
    }
    if (resumed.continuityKey !== key.channelThreadKey) {
      throw new Error(`Agent session "${init.resumeSessionId}" does not match this session key`);
    }
  } else if (key.channelThreadKey) {
    resumed =
      (await deps.sessionRepository.current(key.channelThreadKey, key.agentName)) ?? undefined;
  }

  // The provider keeps a transcript per cwd, so a resumed session reopens
  // where it was written unless the caller names a dir. Legacy rows record none.
  let recordedWorkingDir: string | undefined;
  if (init.workingDir === undefined && resumed?.workingDir) {
    recordedWorkingDir = await reachableRecordedWorkingDir(deps.folders, resumed.workingDir);
    if (!recordedWorkingDir) {
      // The transcript is unreachable. An explicit resume names that exact
      // conversation, so it fails. An implicit reuse by channel-thread key
      // retires the row and starts a fresh generation, so the thread keeps working.
      if (init.resumeSessionId) {
        throw new Error(
          `Agent session "${resumed.id}" ran in "${resumed.workingDir}", which no ` +
            "longer exists; it cannot be resumed there",
        );
      }
      log.warn("agent session working dir is gone; starting a fresh generation", {
        sessionId: resumed.id,
        agentName: key.agentName,
        channelThreadKey: key.channelThreadKey,
        workingDir: resumed.workingDir,
      });
      prepared = resumed.replace();
      await deps.sessionRepository.replace(resumed, prepared);
      resumed = undefined;
    }
  }

  const workingDir =
    init.workingDir ?? recordedWorkingDir ?? (await ensureDefaultWorkingDir(deps.folders));
  const session =
    prepared ??
    resumed ??
    Session.create(key.agentName, {
      continuityKey: key.channelThreadKey || undefined,
      workingDir,
    });
  const sessionId = session.id;
  const isNewSession = !resumed;
  const modelThreadId = resumed?.modelThreadId ?? undefined;
  // The session model pin records the model that produced this history.
  // Precedence: docs/concepts/sessions.md#model-pin.
  const sessionPin =
    resumed?.provider && resumed.model
      ? { providerId: resumed.provider as ProviderId, model: resumed.model }
      : undefined;
  // A cold resume restores the model the session's web chat saved. Only a web
  // chat's own session has one; the web chat side decides which that is.
  const persistedSelection =
    init.resumeSessionId &&
    restoresSavedSelection(config, { pinned: !!sessionPin, selected: !!init.selectionId })
      ? await deps.sessionSettings?.savedModelSelection(sessionId)
      : undefined;
  const selectionId = init.selectionId ?? persistedSelection?.id;

  if (prepared) {
    prepared.moveTo(workingDir);
    await deps.sessionRepository.save(prepared);
  } else if (!resumed) {
    await deps.sessionRepository.add(session);
  }

  let structuredOutputValidator: AnswerShape | undefined;
  if (config.outputSchema) {
    try {
      structuredOutputValidator = deps.readAnswerShape(config.outputSchema);
    } catch (err) {
      throw new Error(
        `Agent ${key.agentName} declares an invalid outputSchema: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Interactive inline UI (`propose_routine` cards, app components) pauses the
  // agent for a human reply. That only works when (a) the channel's surface can
  // render it, and (b) this session will actually receive the next user turn.
  // Subagents fail (b): the parent turn blocks on the child, and the next user
  // turn always routes to the main agent — so a suspended subagent call would
  // hang forever. Where this is false, an action that returns `renderComponent`
  // falls back to relaying its `promptText` as prose; see `actionToolOutput`.
  // The answer feeds the cached system prompt, so the opener states it for
  // the session's life.
  const widgets = widgetDrawingFor({
    placeDrawsCards: init.drawsCards === true,
    isSubagent: !!opts.isSubagent,
  });

  const systemPrompt = deps.systemPrompts.build(
    { ...config, name: agent.localName, owner: agent.ownerType },
    { contextSuffix: init.contextSuffix, widgets },
  );

  // What the agent's definition lets it call, for the ports behind its tools.
  const allowList = config.actions ?? [];
  const subagents = subagentsOf(deps.agentLoader, config);
  const subagentToolNames = new Set(subagents.map((subagent) => subagentToolName(subagent.name)));

  let externalMcpServers: Record<string, McpServerConfig> | undefined;
  if (config.networkDiscovery) {
    const discovered = deps.networkMcpServers();
    if (Object.keys(discovered).length > 0) {
      externalMcpServers = { ...config.mcpServers, ...discovered };
    }
  }

  // We hold the AgentSessionImpl handle in a closure so the action
  // callback can route channel-context / shared-context from the right place.
  let impl!: AgentSessionImpl;

  // Re-bind into the current turn's OTel context so `action:*` spans land
  // under the agent span even when the SDK invokes this callback async.
  // The original `context.with(turnCtx, sendUserInput)` block is no longer
  // active by the time MCP tool callbacks fire.
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
    getChildManager: () => impl.childManager,
    childChannelThreadKey: key.channelThreadKey,
    attachSubagentCall: (toolUseId, call) => impl.addSubagentCall(toolUseId, call),
    bindTurnCtx: inCurrentTurnCtx,
  };

  // The facts the ports behind the Rome tools read, for the turns the refs run.
  const turnFacts = (
    refs: TurnExecRefs,
    pushLevel: () => PushLevel | undefined = () => undefined,
  ): TurnFacts => ({
    agentName: key.agentName,
    continuityKey: key.channelThreadKey,
    sessionId: refs.sessionId,
    isSubagent: opts.isSubagent === true,
    actions: allowList,
    widgets,
    turnId: refs.getTurnId,
    threadContext: refs.getThreadContext,
    sharedContext: refs.getSharedContext,
    pushLevel,
    inTurn: refs.bindTurnCtx,
  });
  const liveTurn = turnFacts(sessionExecRefs, () => impl.currentTurnPushLevelRef);

  // `defer`: schedule a one-off wakeup back into this same thread, through
  // the turn's facts (`deps.defer`). Only
  // wired for guardian-facing threads with a real `channelThreadKey` to wake;
  // keyless/synthetic runs (e.g. envoy validation) and subagents (which reuse
  // the parent's thread key) get no defer tool — a wakeup is a top-level
  // conversation primitive.
  const deferEnabled = init.guardianFacing === true && !opts.isSubagent;
  const deferTool = (): DeferTool | undefined =>
    deferEnabled
      ? {
          schedule: (turn, wakeUp) => deps.defer.schedule(turn, wakeUp),
          finalText: resolveAgentPolicy({ name: agent.localName, policy: config.policy }).finalText,
        }
      : undefined;

  const makeExecuteSubagent =
    (refs: TurnExecRefs) =>
    async (name: string, input: unknown, toolContext: ModelToolCallContext): Promise<unknown> =>
      refs.bindTurnCtx(async () => {
        const parentTurnId = refs.getTurnId();
        if (!parentTurnId) {
          throw new Error("execute_subagent called outside an active Parent turn");
        }
        if (!deps.subagentCalls || !deps.subagentSessions) {
          throw new Error("SubagentCalls is not configured");
        }
        const call = await deps.subagentCalls.call(name, subagentRequest(input), {
          key: {
            parentSessionId: refs.sessionId,
            turnId: parentTurnId,
            toolUseId: toolContext.toolUseId,
          },
          chat: refs.getRomeSessionId(),
          agentName: key.agentName,
          agentSessionId: refs.sessionId,
          sessions: deps.subagentSessions(refs.getChildManager(), refs.childChannelThreadKey, {
            toolEnv: init.toolEnv,
            spanAttributes: init.spanAttributes,
          }),
          at: {
            workingDir,
            threadContext: refs.getThreadContext(),
            sharedContext: refs.getSharedContext(),
          },
        });
        try {
          refs.attachSubagentCall(toolContext.toolUseId, call);
        } catch (err) {
          deps.subagentCalls.forget({
            parentSessionId: refs.sessionId,
            turnId: parentTurnId,
            toolUseId: toolContext.toolUseId,
          });
          await call.cancel("Parent turn ended before Child attachment").catch(() => undefined);
          throw err;
        }
        return { ...(await call.outcome), sessionId: call.sessionId, turnId: call.turnId };
      });

  const reasoningEffort = init.reasoningEffort ?? config.reasoningEffort;

  // The Rome tools a session serves, bound to the refs that run them. The live
  // session has a speaker; a fork has none and may have no `defer`, and its
  // session tools are its source's (`forkSessionTools`).
  const romeTools = (
    refs: TurnExecRefs,
    session: { hasSpeaker: boolean; sessionTools: readonly RomeTool[]; defers: boolean },
    turn: TurnFacts = turnFacts(refs),
  ) =>
    createRomeTools({
      turn,
      actions: deps.actions,
      skills: deps.skillCatalog,
      subagents: { list: () => subagents, run: makeExecuteSubagent(refs) },
      // Without a speaker, action results that hand back a widget take their
      // plain-text forms. Otherwise the tool result claims a card was shown
      // while nothing mounted and the fork dead-ends.
      widgetsShow: showsWidgets(widgets, session.hasSpeaker),
      log,
      defer: session.defers ? deferTool() : undefined,
      sessionTools: session.sessionTools,
    });
  const liveRomeTools = (sessionTools: readonly RomeTool[]) =>
    romeTools(sessionExecRefs, { hasSpeaker: true, sessionTools, defers: true }, liveTurn);

  const buildSessionParams = (
    resolution: ModelResolution,
    tools: RomeTools,
    resumeProviderId?: string | null,
    resumeThreadId?: string,
  ): ModelSessionParams => ({
    config: {
      model: resolution.model,
      systemPrompt,
      builtinTools: config.tools.filter((name) => resolution.modelProvider.builtinTools.has(name)),
      reasoningEffort,
      outputSchema: config.outputSchema,
      workingDir,
      externalMcpServers,
      env: { ...init.toolEnv },
      maxTurns: config.maxTurns,
    },
    tools,
    // A thread resumes only on the provider that named it; another provider
    // starts a new one.
    thread:
      resumeThreadId !== undefined && resumeProviderId === resolution.modelProvider.id
        ? { kind: "resume", modelThreadId: resumeThreadId }
        : { kind: "new" },
  });

  // Captured on every successful open (including reopens) so exact-mode forks
  // can mirror the live session's provider-visible surface field-for-field —
  // identity by construction: a field added to ModelSessionParams flows into
  // exact forks without a second hand-maintained list.
  let lastOpenParams: ModelSessionParams | undefined;
  // The session tools the live session last opened with. A fork's are these
  // (`forkSessionTools`); the run carries them until a session's tools are stored.
  let sourceSessionTools: readonly RomeToolDefinition[] = [];

  const openModelSession = async (
    resolution: ModelResolution,
    resumeProviderId?: string | null,
    resumeThreadId?: string,
  ): Promise<ModelSession> => {
    const sessionTools = await deps.sessionTools.forTurn(liveTurn, true);
    const params = buildSessionParams(
      resolution,
      liveRomeTools(sessionTools),
      resumeProviderId,
      resumeThreadId,
    );
    const resumed = params.thread.kind === "resume";
    const openStartMs = Date.now();
    const session = await deps.sessionTracing.withSpan(
      "model.session.open",
      {
        provider: resolution.modelProvider.id,
        resumed,
        "agent.name": key.agentName,
        is_subagent: opts.isSubagent,
      },
      () => resolution.modelProvider.openSession(params),
    );
    deps.turnUsage.modelSessionOpened({
      provider: resolution.modelProvider.id,
      resumed,
      durationMs: Date.now() - openStartMs,
    });
    lastOpenParams = params;
    sourceSessionTools = sessionTools;
    return session;
  };

  /**
   * Open-params factory for forked turns (see `fork`). Both modes
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
  const buildForkOpenParams: BuildForkOpenParams = async (fork) => {
    const { opening } = fork;
    // A continuable fork's model thread is its own; a one-shot one is closed after its turn.
    const thread: ThreadStart = {
      kind: "branch",
      at: opening.sourceTurn,
      lifetime: opening.oneShot ? "ephemeral" : "kept",
    };
    if (opening.mode !== "exact") {
      return {
        params: {
          config: {
            model: fork.model,
            systemPrompt,
            builtinTools: [],
            reasoningEffort,
            outputSchema: config.outputSchema,
            workingDir,
            // A fork's tools run with its source's.
            env: { ...init.toolEnv },
          },
          thread,
          tools: NO_ROME_TOOLS,
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
    // (`SessionRepository.current` would otherwise resume the source child's
    // model thread). keepAlive gives one forked turn child continuity across
    // repeated calls to the same subagent; `fork` disposes the manager
    // when the fork ends, so fork children never outlive the fork.
    let forkChildManager: Sessions | undefined;
    const forkSubagentCalls = new Map<string, { key: SubagentCallKey; call: SubagentCall }>();
    const forkPendingSubagentUses = new Map<string, Extract<AgentEvent, { type: "tool_use" }>>();
    const forkEmittedSubagentStarts = new Set<string>();
    const maybeEmitForkSubagentStart = (toolUseId: string): void => {
      if (forkEmittedSubagentStarts.has(toolUseId)) return;
      const use = forkPendingSubagentUses.get(toolUseId);
      const linked = forkSubagentCalls.get(toolUseId);
      if (!use || !linked) return;
      forkEmittedSubagentStarts.add(toolUseId);
      forkPendingSubagentUses.delete(toolUseId);
      fork.emit({
        type: "subagent_start",
        toolUseId,
        agentName: linked.call.subagent,
        input: use.input,
        sessionId: linked.call.sessionId,
        turnId: linked.call.turnId,
        ...(use.startedAt ? { startedAt: use.startedAt } : {}),
      });
    };
    const refs: TurnExecRefs = {
      sessionId: fork.forkSessionId,
      getRomeSessionId: () => fork.forkSessionId,
      getTurnId: () => fork.forkTurnId,
      getThreadContext: () => opening.threadContext,
      getSharedContext: () => init.sharedContext,
      getChildManager: () => {
        if (!forkChildManager) {
          forkChildManager = createSessions(deps, {
            keepAliveAcrossTurns: true,
            isSubagent: true,
            turns: opts.turns,
          });
        }
        return forkChildManager;
      },
      childChannelThreadKey: storeForkParent(key.channelThreadKey, fork.forkSessionId),
      attachSubagentCall: (toolUseId, call) => {
        forkSubagentCalls.set(toolUseId, {
          key: { parentSessionId: fork.forkSessionId, turnId: fork.forkTurnId, toolUseId },
          call,
        });
        maybeEmitForkSubagentStart(toolUseId);
      },
      // Forked turns open no agent span; run tool callbacks on the ambient
      // OTel context instead of re-binding into a source turn's span.
      bindTurnCtx: (fn) => fn(),
    };
    const liveOpenParams = lastOpenParams;
    return {
      params: {
        ...liveOpenParams,
        thread,
        config: { ...liveOpenParams.config, model: fork.model },
        // The same catalog as the live session, run through fresh fork-bound
        // callbacks, never the source's per-turn closures.
        tools: romeTools(refs, {
          hasSpeaker: false,
          sessionTools: forkSessionTools(
            sourceSessionTools,
            await deps.sessionTools.forTurn(turnFacts(refs), false),
          ),
          // A continuable fork holds no scheduled wake-ups: its wake-up would
          // resume the fork session while delivering under the thread context
          // this turn inherited, which is still the source's.
          defers: opening.oneShot,
        }),
      },
      projectProviderMessage: async (msg) => {
        if (msg.type === "tool_input_delta" && subagentToolNames.has(msg.tool)) {
          return [];
        }
        if (msg.type === "tool_use" && subagentToolNames.has(msg.tool)) {
          forkPendingSubagentUses.set(msg.id, msg);
          maybeEmitForkSubagentStart(msg.id);
          return [];
        }
        if (msg.type !== "tool_result") return [msg];
        const linked = forkSubagentCalls.get(msg.toolUseId);
        if (linked) {
          const completion = await linked.call.outcome;
          deps.subagentCalls?.forget(linked.key);
          const common = {
            type: "subagent_result" as const,
            toolUseId: msg.toolUseId,
            agentName: linked.call.subagent,
            sessionId: linked.call.sessionId,
            turnId: linked.call.turnId,
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
          [...forkSubagentCalls.values()].map(({ call }) =>
            call.cancel("Forked Parent turn ended"),
          ),
        );
        for (const { key } of forkSubagentCalls.values()) {
          deps.subagentCalls?.forget(key);
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
  // Whether the provider continues a thread it already has, rather than
  // starting one that has seen nothing of this chat.
  let threadResumed = false;
  if (config.codeBacked) {
    modelSession = createNullModelSession({
      ...buildSessionParams(
        {
          modelProvider: {
            id: "mock",
            builtinTools: new Set(),
            openSession: async () => {
              throw new Error("Code-backed agents do not open model sessions");
            },
          },
          model: "code-backed",
        },
        liveRomeTools(await deps.sessionTools.forTurn(liveTurn, true)),
      ),
    });
  } else {
    initialResolution = await deps.modelResolver.resolve(
      modelResolutionRequest(selectionId, sessionPin, config),
    );
    modelSession = await openModelSession(initialResolution, resumed?.provider, modelThreadId);
    threadResumed =
      modelThreadId !== undefined && resumed?.provider === initialResolution.modelProvider.id;
  }
  // A resume the caller moved to another dir now writes its transcript there,
  // so the row follows it once the provider has opened.
  if (resumed && resumed.workingDir !== workingDir) {
    resumed.moveTo(workingDir);
    await deps.sessionRepository.save(resumed);
  }

  impl = new AgentSessionImpl({
    key,
    session,
    modelSession,
    deps,
    config,
    structuredOutputValidator,
    systemPrompt,
    workingDir,
    buildForkOpenParams,
    liveTurn,
    turns: opts.turns,
    owningAppId,
    threadContext: init.threadContext,
    sharedContext: init.sharedContext,
    spanAttributes: init.spanAttributes,
    isNewSession,
    isSubagent: opts.isSubagent,
    kind: opts.isSubagent
      ? "subagent"
      : (init.kind ?? (init.threadContext ? "conversation" : "action")),
    selectionId,
    sessionPin,
    threadResumed,
    // The row recorded a thread this open does not resume: another provider
    // now runs the chat, and its new thread has seen none of it.
    replacedThread: !threadResumed && !!resumed?.modelThreadId,
    previousModel: resumed?.model ?? undefined,
    openModelSession,
    modelProvider: initialResolution?.modelProvider,
    toolCount:
      (initialResolution
        ? config.tools.filter((name) => initialResolution.modelProvider.builtinTools.has(name))
            .length
        : 0) + subagents.length,
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
  /** The facts the session's own turns hand the ports behind its tools. */
  liveTurn: TurnFacts;
  /** Where the session's turns are found by id. */
  turns: TurnsById;
  /** What the opener stamps on every turn's spans. */
  spanAttributes?: Attributes;
  session: Session;
  modelSession: ModelSession;
  /** The provider of the session the run opened. Unset for a code-backed agent. */
  modelProvider?: ModelProvider;
  deps: ManagerDeps;
  config: AgentDefinition;
  structuredOutputValidator?: AnswerShape;
  systemPrompt: string;
  workingDir: string;
  /** Builds the open params for a forked turn's session (mode-aware). */
  buildForkOpenParams: BuildForkOpenParams;
  /** The app that owns the agent, when an app does. */
  owningAppId?: string;
  threadContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
  /** Whether the underlying SDK session was freshly minted (vs resumed). */
  isNewSession: boolean;
  /** Subagent sessions get no thread-context block (they get no contextSuffix today either). */
  isSubagent: boolean;
  kind: SessionKind;
  selectionId?: ModelSelectionId;
  /** Session model pin from the resumed row, when one exists. */
  sessionPin?: { providerId: ProviderId; model: string };
  /** The opened provider session continues a thread the row recorded. */
  threadResumed: boolean;
  /** The opened provider session starts a new thread in place of the row's. */
  replacedThread: boolean;
  /** The model the row's thread ran on. */
  previousModel?: string;
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
  /** The turn's prompt carries the `<continuation>` notice, which stays due
   *  until the turn returns a result. */
  carriesContinuation?: boolean;
  /** Prompt that opened the turn; carried on the turn_start event. */
  userPrompt: string;
  /** Guards the one-turn_start-per-stream invariant across error paths. */
  turnStartEmitted: boolean;
  /** The turn's own record of what it said and how it ended. */
  writer: TurnWriter;
  /** The first result or error the turn said, which its ending carries. */
  saidTerminal?: TurnResultEvent | TurnErrorEvent;
  done: boolean;
  /**
   * Captured block stream for this turn — every AgentEvent yielded by
   * `modelSession.events` on this turn, with the wall-clock ts we observed
   * it at. Drained at terminal time by `translateTurnSpans` to emit
   * `tool` spans + thinking/text events under `model.turn`. Includes blocks
   * the sink itself drops (e.g. subagent tool_results) so per-tool spans
   * are reconstructed for subagent dispatch from the parent's view.
   */
  blocks: CapturedEvent[];
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
   * once in startTurn and stamped on every span this turn creates. Carried
   * here rather than via OTel baggage so they don't leak into outbound
   * HTTP/gRPC headers via the default propagator.
   */
  romeAttrs: Attributes;
  lifecycleStartedAt?: string;
  lifecycleStartedAtMs?: number;
  lifecycleParent?: AgentTurnParentRef;
  threadContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
  romeSessionId: string;
  replyTo?: MessageReplyReference;
  quoted?: PromptMessage | null;
  initiatedBy?: "user" | "system";
  pushLevel?: PushLevel;
  lifecycleFinishDispatched: boolean;
  lifecycleInterrupted: boolean;
  subagentCallsByToolUse: Map<string, { key: SubagentCallKey; call: SubagentCall }>;
  pendingSubagentToolUses: Map<string, Extract<AgentEvent, { type: "tool_use" }>>;
  emittedSubagentStarts: Set<string>;
  subagentLinksCleared: boolean;
  /** A schema-bound turn is terminal-only and cannot be resumed after a parked action. */
  outputSchemaSuspended: boolean;
  /** The id the provider named the turn with, if it did. */
  modelTurnId?: string;
  /** The login kind of the provider session that executes this turn. */
  loginKind?: ModelLoginKind;
  usageRecorded: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * True when a tool result parked the turn on a pending interaction or an
 * approval. Tool results may reach us directly, JSON-encoded, or wrapped
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
  return isRecord(value) && (value.pendingInteraction === true || value.pendingApproval === true);
}

/**
 * Take the provider's facts off a model event. They stay in the run and never
 * reach the wire, the trace or app hooks.
 */
function splitProviderFacts(event: Exclude<ModelSessionEvent, ModelTurnStartedEvent>): {
  msg: AgentEvent;
  reasoningEffort?: string;
  position?: ModelPosition;
} {
  if (event.type === "result") {
    const { reasoningEffort, position, ...msg } = event;
    return { msg, reasoningEffort, position };
  }
  return { msg: event };
}

function validateProviderStructuredResult(
  message: AgentEvent,
  shape: AnswerShape | undefined,
  suspended = false,
): AgentEvent {
  if (!shape || message.type !== "result") return message;
  return shapedResult(message, shape, suspended);
}

/**
 * Serialized outbound stream for one forked turn. The provider-event pump and
 * out-of-band emitters (for example exact-mode subagent relays) push
 * concurrently; `fork` drains in arrival order. Pushes after `end()`
 * are dropped; anything pushed after the drain loop stops at the terminal
 * block is buffered but never read.
 */
class ForkStreamQueue implements AsyncIterable<StreamAgentEvent> {
  private buffer: StreamAgentEvent[] = [];
  private resolvers: Array<(item: IteratorResult<StreamAgentEvent>) => void> = [];
  private ended = false;

  push(msg: StreamAgentEvent): void {
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

  [Symbol.asyncIterator](): AsyncIterator<StreamAgentEvent> {
    return {
      next: async (): Promise<IteratorResult<StreamAgentEvent>> => {
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
  /** The stored session this one runs, which each turn and touch is recorded on. */
  private readonly session: Session;
  status: AgentSessionStatus = "idle";
  currentTurnId?: string;
  get runningTurn(): Turn | undefined {
    return this.currentTurnId ? this.turns.find(this.currentTurnId) : undefined;
  }
  lastActiveAt = Date.now();
  private activeForkedTurnCount = 0;
  // Forks run in this session's working dir; actions they call carry the fork's id.
  private activeForkSessionIds = new Set<string>();
  // Manager built lazily for subagent runs; keeps subagents owned by this session.
  private _childManager?: Sessions;
  private modelSession: ModelSession;
  private modelProvider?: ModelProvider;
  /** Where the latest turn left the thread, if it did. A fork with no checkpoint branches here. */
  private lastPosition?: ModelPosition;
  private deps: ManagerDeps;
  private get log(): AgentLog {
    return this.deps.log;
  }
  private config: AgentDefinition;
  private structuredOutputValidator?: AnswerShape;
  private systemPrompt: string;
  private workingDir: string;
  private buildForkOpenParams: BuildForkOpenParams;
  private readonly liveTurn: TurnFacts;
  private readonly turns: TurnsById;
  private attribution: TurnAttribution;
  private threadContext?: ThreadContext;
  private sharedContext?: Record<string, unknown>;
  private statusListeners = new Map<string, AgentSessionStatusListener>();
  private currentSink: TurnSink | null = null;
  // Spans for the current turn. Both are opened in runOneTurn and closed in
  // runEventsLoop when the terminal `result`/`error` message lands, so the
  // trace contract is complete by the time the sink closes (i.e. before
  // consumer for-await loops drain). runOneTurn's finally is idempotent.
  private currentAgentSpan: Span | null = null;
  private currentModelSpan: Span | null = null;
  // Active OTel context for the current turn, set in runOneTurn after the
  // agent span is created. The action and subagent callbacks re-bind into it
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
  /** What the session serves, fixed for its life. */
  readonly kind: SessionKind;
  private readonly spanAttributes: Attributes;
  // One-shot guard: the `<thread_context>` block is prepended to the FIRST user
  // turn of a fresh session only. Flipped the first time runOneTurn considers it
  // so it never reappears on later turns of the same session.
  private threadContextInjected = false;
  /**
   * The current model thread started in this session rather than resuming
   * one, so its first turn carries the `<thread_context>` block.
   */
  private threadFresh: boolean;
  /**
   * The current thread replaced one that held this chat, so its turns carry a
   * `<continuation>` notice to read the earlier messages until one returns a
   * result: a turn that fails may never have reached the thread.
   */
  private continuationPending: boolean;
  /** The model the chat ran on before the current thread started. */
  private previousModel?: string;
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
    (input, options) => this.startTurn(input, options),
    () => this.modelSession,
    (error) =>
      this.log.warn("conversational input dispatch failed", {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
  private keepAlive: boolean;
  private onClosed: () => void;
  private closingPromise?: Promise<void>;

  constructor(args: ImplArgs) {
    this.key = args.key;
    this.session = args.session;
    this.sessionId = args.session.id;
    this.modelSession = args.modelSession;
    this.modelProvider = args.modelProvider;
    this.deps = args.deps;
    this.config = args.config;
    this.structuredOutputValidator = args.structuredOutputValidator;
    this.systemPrompt = args.systemPrompt;
    this.workingDir = args.workingDir;
    this.buildForkOpenParams = args.buildForkOpenParams;
    this.liveTurn = args.liveTurn;
    this.turns = args.turns;
    this.attribution = { agentName: args.key.agentName, owningAppId: args.owningAppId };
    this.threadContext = args.threadContext;
    this.sharedContext = args.sharedContext;
    this.isNewSession = args.isNewSession;
    this.isSubagent = args.isSubagent;
    this.kind = args.kind;
    this.spanAttributes = args.spanAttributes ?? {};
    this.selectionId = args.selectionId;
    this.sessionPin = args.sessionPin;
    this.threadFresh = !args.threadResumed;
    this.continuationPending = args.replacedThread;
    this.previousModel = args.previousModel;
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

  get currentTurnPushLevelRef(): PushLevel | undefined {
    return this.currentSink?.pushLevel;
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

  get workingDirectory(): string {
    return this.workingDir;
  }

  hasActiveFork(forkSessionId: string): boolean {
    return this.activeForkSessionIds.has(forkSessionId);
  }

  /** The subagent manager, or undefined when this session never ran a subagent. */
  get openedChildManager(): Sessions | undefined {
    return this._childManager;
  }

  get childManager(): Sessions {
    if (!this._childManager) {
      // Children share the same dep wiring + keepAlive setting. Flag the
      // child manager as subagent-only so widgets (propose_routine, inline
      // components) stay off on these sessions even when the parent's place draws
      // cards: see `widgetDrawingFor`.
      this._childManager = createSessions(this.deps, {
        keepAliveAcrossTurns: this.keepAlive,
        isSubagent: true,
        turns: this.turns,
      });
    }
    return this._childManager;
  }

  // Per-session events loop: pumps every SDK AgentEvent into the active
  // turn sink. Turn boundaries are detected by `result` / `error`.

  startModelSessionEvents(): void {
    const session = this.modelSession;
    this.modelEventsLoop = this.runEventsLoop(session);
  }

  /**
   * The guardian picked a model in the open chat. The next turn resolves it
   * ahead of the pin, and its successful turn re-pins the session. Null clears
   * the selection, so the pin decides again.
   */
  selectModel(selectionId: ModelSelectionId | null): void {
    this.selectionId = selectionId ?? undefined;
  }

  private async ensureModelSessionForTurn(): Promise<void> {
    if (this.config.codeBacked) return;
    const resolution = await this.deps.modelResolver.resolve(
      modelResolutionRequest(this.selectionId, this.sessionPin, this.config),
    );
    if (
      this.modelSessionAvailable &&
      resolution.modelProvider.id === this.modelSession.providerId &&
      resolution.model === this.modelSession.model
    ) {
      return;
    }

    const previous = this.modelSession;
    const sameProvider = previous.providerId === resolution.modelProvider.id;
    const resumeThreadId = sameProvider ? previous.modelThreadId : undefined;
    this.replacingModelSession = previous;
    this.modelSessionAvailable = false;
    try {
      await previous.close();
      await this.modelEventsLoop;
      this.modelProvider = resolution.modelProvider;
      const next = await this.openModelSession(
        resolution,
        sameProvider ? previous.providerId : undefined,
        resumeThreadId,
      );
      this.modelSession = next;
      this.modelSessionAvailable = true;
      if (resumeThreadId === undefined) {
        // Another provider: the new thread has seen nothing of this chat.
        this.threadFresh = true;
        this.threadContextInjected = false;
        this.lastPosition = undefined;
        if (previous.modelThreadId !== undefined) {
          this.continuationPending = true;
          this.previousModel = previous.model;
        }
      }
      this.toolCount =
        this.config.tools.filter((name) => resolution.modelProvider.builtinTools.has(name)).length +
        subagentsOf(this.deps.agentLoader, this.config).length;
      this.replacingModelSession = null;
      this.startModelSessionEvents();
    } catch (err) {
      this.replacingModelSession = null;
      throw err;
    }
  }

  private async runEventsLoop(session: ModelSession): Promise<void> {
    try {
      this.deps.sessionTracing.enterSession(this.sessionId);
      for await (const event of session.events) {
        const sink = this.currentSink;
        if (!sink) {
          // No active turn — log and drop. Should not happen because
          // startTurn allocates the sink before sendUserInput.
          this.log.warn("agent session received event with no active turn", {
            type: event.type,
            sessionId: this.sessionId,
          });
          continue;
        }
        if (event.type === "model_turn_started") {
          sink.modelTurnId = event.modelTurnId;
          continue;
        }
        const { msg, reasoningEffort, position } = splitProviderFacts(event);
        if (msg.type === "input_status") {
          await this.inputs.observe(msg, sink.turnId);
          this.publishOutbound(sink, { ...msg, turnId: sink.turnId });
          continue;
        }
        if (msg.type === "result" || msg.type === "error") {
          this.deps.turnUsage.modelTurnAccounted(msg.accounting, this.attribution);
          await this.inputs.seal(sink.turnId);
        }
        // Time-to-first-token: the first *text* event of the turn (a text_delta
        // or a completed text block) marks when the model started
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
          this.deps.turnUsage.firstTextProduced({
            model: this.modelSession.model,
            agentName: this.key.agentName,
            isSubagent: this.isSubagent,
            afterMs: ttftMs,
          });
          this.currentModelSpan?.setAttribute("ttft_ms", ttftMs);
        }
        // Deltas are transient increments of an in-flight block; the complete
        // block still follows. Fast-path them straight to the sink: no
        // span-translator capture, no per-delta DB touch, no metrics.
        if (isTransientDelta(msg)) {
          // A subagent call publishes `subagent_start` instead of its
          // `tool_use`, so its input preview would reference nothing.
          if (msg.type === "tool_input_delta" && this.subagentToolNames.has(msg.tool)) {
            continue;
          }
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
        await this.touchSession();

        if (msg.type === "tool_use" && this.subagentToolNames.has(msg.tool)) {
          sink.pendingSubagentToolUses.set(msg.id, msg);
          this.maybePublishSubagentStart(sink, msg.id);
          continue;
        }
        if (msg.type === "tool_result") {
          const linked = sink.subagentCallsByToolUse.get(msg.toolUseId);
          if (linked) {
            const completion = await linked.call.outcome;
            const common = {
              type: "subagent_result" as const,
              toolUseId: msg.toolUseId,
              agentName: linked.call.subagent,
              sessionId: linked.call.sessionId,
              turnId: linked.call.turnId,
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
        let outbound: AgentEvent = validateProviderStructuredResult(
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

        if (isTerminalEvent(outbound)) {
          // The branch action becomes available when turn_end is published.
          // Persist the provider-native anchor first so an immediate click can
          // never fall back to (or race with) a later model-thread head.
          if (outbound.type === "result") {
            const interrupted =
              turnStatus({ terminal: outbound, stoppedByRome: sink.lifecycleInterrupted }) ===
              "interrupted";
            if (!interrupted) this.lastPosition = position;
            await this.persistTurn(
              session,
              sink.turnId,
              reasoningEffort,
              interrupted ? undefined : position,
            );
            if (sink.carriesContinuation) this.continuationPending = false;
          }
          // Use `outbound` (not `msg`) so provider-output validation is
          // reflected in span status and the turn_end bracket. The turn_end
          // bracket ships after the spans close, so the trace contract is
          // complete by the time consumers observe the end of the turn.
          this.finalizeTurn(sink, outbound);
        }
      }
    } catch (err) {
      this.log.warn("agent session events loop ended", {
        sessionId: this.sessionId,
        provider: session.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (this.replacingModelSession === session || this.modelSession !== session) return;
      const sink = this.currentSink;
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
   * started (session closed, startTurn threw) call it from failTurn so every
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
  private publishTurnEnd(sink: TurnSink, terminal: TurnResultEvent | TurnErrorEvent): void {
    // Turns that fail before dispatchTurnStarted have no start timestamp;
    // report 0 rather than a since-epoch wall clock.
    const startMs = sink.lifecycleStartedAtMs;
    this.publishOutbound(sink, {
      type: "turn_end",
      turnId: sink.turnId,
      status: turnStatus({ terminal, stoppedByRome: sink.lifecycleInterrupted }),
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
  private finalizeTurnSpans(sink: TurnSink, outbound: TurnResultEvent | TurnErrorEvent): void {
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
        this.deps.turnUsage.promptCacheChecked({
          model: this.modelSession.model,
          isSubagent: this.isSubagent,
          hit: (u.cacheReadTokens ?? 0) > 0,
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
          this.log.warn("turn-span translator threw", {
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
      this.deps.turnUsage.turnTimed(this.key.agentName, Date.now() - this.currentTurnStartMs);
    }
    this.currentTurnCtx = null;
  }

  private finalizeTurn(sink: TurnSink, terminal: TurnResultEvent | TurnErrorEvent): void {
    if (this.currentSink === sink) {
      this.finalizeTurnSpans(sink, terminal);
    }
    // A turn that stopped before the provider named the thread leaves nothing
    // behind, so the next turn starts a thread that has seen no context.
    if (
      (sink.lifecycleInterrupted || terminal.type === "error") &&
      this.modelSession.modelThreadId === undefined
    ) {
      this.threadContextInjected = false;
    }
    this.publishTurnEnd(sink, terminal);
    this.dispatchTurnFinished(sink, terminal);
    this.recordTurnUsage(sink, terminal);
    this.closeSink(sink);
  }

  private recordTurnUsage(sink: TurnSink, terminal: TurnResultEvent | TurnErrorEvent): void {
    if (sink.usageRecorded) return;
    sink.usageRecorded = true;
    const accounting = terminal.accounting;
    this.deps.turnUsage.turnEnded({
      turnId: sink.turnId,
      romeSessionId: sink.romeSessionId,
      sessionKind: this.kind,
      agentName: this.key.agentName,
      status: turnStatus({ terminal, stoppedByRome: sink.lifecycleInterrupted }),
      provider: this.modelSession.providerId,
      model: this.modelSession.model,
      loginKind: sink.loginKind,
      providerTurnId: sink.modelTurnId,
      accounting,
      durationMs:
        sink.lifecycleStartedAtMs === undefined
          ? accounting?.durationMs
          : Date.now() - sink.lifecycleStartedAtMs,
      finishedAt: new Date(),
    });
  }

  /**
   * Terminate a turn on a failure path: publish the error block, then bracket
   * and close the turn.
   */
  private failTurn(sink: TurnSink, error: string | ModelResolutionErrorPayload): void {
    const terminal: TurnErrorEvent =
      typeof error === "string" ? { type: "error", error } : { type: "error", ...error };
    this.ensureTurnStart(sink);
    this.publishOutbound(sink, terminal);
    this.finalizeTurn(sink, terminal);
  }

  private mayCall(actionName: string): boolean {
    return this.deps.actions.permits(this.liveTurn, actionName);
  }

  private async touchSession(): Promise<void> {
    this.session.touch();
    await this.deps.sessionRepository.save(this.session);
  }

  /**
   * Records what the turn ran on: the provider, its native thread, the
   * concrete model (the session model pin), the applied effort, and the
   * turn's checkpoint, so a fork can branch at it. An interrupted turn has no
   * checkpoint to branch at. The checkpoint is written before `turn_end` is
   * published, so an immediate branch never falls back to a later thread head.
   */
  private async persistTurn(
    session: ModelSession,
    turnId: string,
    reasoningEffort: string | undefined,
    position: ModelPosition | undefined,
  ): Promise<void> {
    try {
      this.session.recordTurn({
        provider: session.providerId,
        modelThreadId: session.modelThreadId,
        model: session.model,
        reasoningEffort,
        checkpoint: position ? { turnId, checkpointId: position.checkpointId } : undefined,
      });
      await this.deps.sessionRepository.save(this.session);
      // The pin becomes readable only once recorded: later turns of this live
      // session now resolve exactly this model, matching what a cold resume
      // of the row would do.
      this.sessionPin = { providerId: session.providerId, model: session.model };
    } catch (err) {
      this.log.warn("failed to persist session turn", {
        sessionId: this.sessionId,
        turnId,
        provider: session.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Leave a completed fork behind as its own resumable conversation: an
   * agent-session row keyed by the fork's channel-thread key and pinned to the
   * model thread the fork actually ran on.
   *
   * Best-effort by construction. The fork's answer has already been delivered,
   * so a failed write costs only continuability and must never surface as a
   * turn error. A provider that hands back no thread id has nothing to resume,
   * so the fork stays one-shot rather than getting a row that cannot open.
   */
  private async persistForkThread(
    channelThreadKey: string,
    forkSessionId: string,
    forkSession: ModelSession,
    reasoningEffort: string | undefined,
  ): Promise<void> {
    const modelThreadId = forkSession.modelThreadId;
    if (!modelThreadId) {
      this.log.info("fork thread not persisted: provider exposed no thread id", {
        sessionId: this.sessionId,
        forkSessionId,
        provider: forkSession.providerId,
      });
      return;
    }
    try {
      const fork = Session.create(this.key.agentName, {
        // The fork's chat and its turn's events already carry the id the
        // fork minted when its turn started.
        deprecatedId: forkSessionId,
        continuityKey: channelThreadKey,
        workingDir: this.workingDir,
      });
      fork.recordTurn({
        provider: forkSession.providerId,
        modelThreadId,
        model: forkSession.model,
        reasoningEffort,
      });
      await this.deps.sessionRepository.add(fork);
    } catch (err) {
      this.log.warn("failed to persist fork thread; the branch stays one-shot", {
        sessionId: this.sessionId,
        forkSessionId,
        channelThreadKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private publishOutbound(sink: TurnSink, msg: AgentEvent): StreamAgentEvent {
    const outbound: StreamAgentEvent = { ...msg, agent: this.key.agentName };
    this.publishToSink(sink, outbound);
    return outbound;
  }

  private publishToSink(sink: TurnSink, msg: StreamAgentEvent): void {
    if (sink.done) return;
    if (!sink.saidTerminal && (msg.type === "result" || msg.type === "error")) {
      sink.saidTerminal = msg;
    }
    sink.writer.record(msg);
  }

  private trackTurnMetrics(msg: AgentEvent | StreamAgentEvent): void {
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
    sink.writer.end({ terminal: sink.saidTerminal, stoppedByRome: sink.lifecycleInterrupted });
    this.clearSubagentLinks(sink);
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
    for (const { key } of sink.subagentCallsByToolUse.values()) {
      this.deps.subagentCalls?.forget(key);
    }
  }

  private dispatchTurnStarted(sink: TurnSink, input: AgentTurnInput): void {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    sink.lifecycleStartedAtMs = startedAtMs;
    sink.lifecycleStartedAt = startedAt;
    this.deps.turnLifecycle.started({
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
      },
    });
  }

  private dispatchTurnFinished(sink: TurnSink, terminal?: StreamAgentEvent): void {
    if (sink.lifecycleFinishDispatched) return;
    if (!sink.lifecycleStartedAt || sink.lifecycleStartedAtMs === undefined) {
      // A turn that failed before it started, such as on a model that cannot
      // be resolved, has no finished event; in-process listeners still hear.
      if (terminal?.type === "error") {
        sink.lifecycleFinishDispatched = true;
        this.deps.turnLifecycle.couldNotStart({
          turn: createAgentTurnRef({
            sessionId: this.sessionId,
            turnId: sink.turnId,
            agentName: this.key.agentName,
            channelThreadKey: this.key.channelThreadKey,
            threadContext: sink.threadContext ?? this.threadContext,
            parent: sink.lifecycleParent,
          }),
          error: terminal.error,
        });
      }
      return;
    }
    sink.lifecycleFinishDispatched = true;

    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();
    const startedAt = sink.lifecycleStartedAt ?? finishedAt;
    const durationMs =
      sink.lifecycleStartedAtMs === undefined ? 0 : finishedAtMs - sink.lifecycleStartedAtMs;
    const ending: TurnEnding = {
      terminal: terminal?.type === "result" || terminal?.type === "error" ? terminal : undefined,
      stoppedByRome: sink.lifecycleInterrupted,
    };

    this.deps.turnLifecycle.ended({
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
      timing: buildRequiredTiming({
        startedAt,
        finishedAt,
        durationMs,
      }),
      ...endedTurn(ending, this.modelSession.providerId),
      metrics: {
        toolCallCount: this.currentTurnToolCallCount,
        skillWritten: this.currentTurnSkillWritten,
      },
    });
  }

  /**
   * Runs a forked turn, which is found by id like any other turn but cannot be
   * stopped: it runs until its stream ends or its reader stops reading.
   */
  async *fork(input: ForkedAgentTurnInput): AsyncIterable<StreamAgentEvent> {
    let writer: TurnWriter | undefined;
    let said: TurnResultEvent | TurnErrorEvent | undefined;
    try {
      for await (const event of this.forkedTurnEvents(input)) {
        if (!writer && event.type === "turn_start") {
          const forked = createTurn(event.turnId, null);
          writer = forked.writer;
          this.turns.add(forked.turn);
        }
        if (!said && (event.type === "result" || event.type === "error")) said = event;
        writer?.record(event);
        yield event;
      }
    } finally {
      writer?.end({ terminal: said, stoppedByRome: false });
    }
  }

  private async *forkedTurnEvents(input: ForkedAgentTurnInput): AsyncIterable<StreamAgentEvent> {
    if (this.status === "closed") {
      throw new Error(`AgentSession ${this.sessionId} is closed`);
    }
    this.activeForkedTurnCount++;
    this.lastActiveAt = Date.now();
    // Forked turns bracket their stream like regular turns; the ids are
    // minted here because no startTurn is involved. No per-turn session_init
    // is synthesized: that re-emission is an ordinary-turn compatibility
    // shim slated for removal (step 2 of the stream-shape cleanup), and
    // forked-stream consumers read identity off turn_start.
    const forkSessionId = uuidv7();
    this.activeForkSessionIds.add(forkSessionId);
    const turnId = uuidv7();
    const startMs = Date.now();

    // Bracketing invariant: once turn_start is out, the stream must end
    // with a terminal block followed by turn_end — even when fork setup
    // rejects, the fork throws mid-stream, or its event stream ends without
    // a terminal. Mirror the failTurn handling of regular turns by
    // synthesizing the error terminal here.
    let forkSession: ModelSession | undefined;
    let opening: ForkOpening | undefined;
    let sourceLoginKind: ModelLoginKind | undefined;
    let forkLoginKind: ModelLoginKind | undefined;
    let forkModelTurnId: string | undefined;
    let forkReasoningEffort: string | undefined;
    let disposeForkResources: (() => Promise<void>) | undefined;
    let status: "completed" | "interrupted" | "error" = "completed";
    let terminalSeen = false;
    let terminalAccounting: TurnResultEvent["accounting"];
    let outputSchemaSuspended = false;
    // Assigned inside the mutex below, after ensureModelSessionForTurn() may
    // have replaced this.modelSession. See the guard in the `finally`.
    let sourceModelThreadId: string | undefined;
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
        // The resolver may have moved the source to another model; forks take
        // the same gate as ordinary turns before reading it. Keep the lock only
        // through descriptor creation so the independent fork does not block
        // later source turns.
        const { modelProvider, forkOpen, outbound } = await this.turnMutex.runExclusive(
          async () => {
            if (this.status === "closed") {
              throw new Error(`AgentSession ${this.sessionId} is closed`);
            }
            await this.ensureModelSessionForTurn();
            const sourceModelSession = this.modelSession;
            sourceLoginKind = sourceModelSession.loginKind;
            sourceModelThreadId = sourceModelSession.modelThreadId;
            if (!this.modelProvider) throw new Error("a code-backed agent session cannot fork");
            const forkOpening = openFork(
              {
                providerId: sourceModelSession.providerId,
                modelThreadId: sourceModelSession.modelThreadId,
                lastPosition: this.lastPosition,
                threadContext: this.threadContext,
              },
              input,
              forkSessionId,
            );
            opening = forkOpening;
            const forkModel = input.tier
              ? await this.deps.modelResolver.resolve({
                  kind: "tier",
                  tier: input.tier,
                  providerId: sourceModelSession.providerId,
                })
              : undefined;
            // One serialized outbound stream for the whole forked turn: the
            // provider-event pump below and out-of-band emitters (exact-mode
            // subagent relays) push concurrently; the drain
            // loop yields in arrival order. A provider stream failure becomes the
            // turn's terminal error block, preserving the bracketing invariant.
            const outbound = new ForkStreamQueue();
            const forkOpen = await this.buildForkOpenParams({
              opening: forkOpening,
              forkSessionId,
              forkTurnId: turnId,
              model: forkModel?.model ?? sourceModelSession.model,
              emit: (msg) => outbound.push(msg),
            });
            return { modelProvider: this.modelProvider, forkOpen, outbound };
          },
        );
        disposeForkResources = forkOpen.dispose;
        forkSession = await modelProvider.openSession(forkOpen.params);
        forkLoginKind = forkSession.loginKind;
        await forkSession.sendUserInput({
          text: input.prompt,
          reasoningEffort: input.reasoningEffort,
        });
        const providerEvents = forkSession.events;
        void (async () => {
          try {
            for await (const event of providerEvents) {
              if (event.type === "model_turn_started") {
                forkModelTurnId = event.modelTurnId;
                continue;
              }
              const { msg, reasoningEffort } = splitProviderFacts(event);
              if (msg.type === "result" || msg.type === "error") {
                forkReasoningEffort = reasoningEffort;
                this.deps.turnUsage.modelTurnAccounted(msg.accounting, this.attribution);
              }
              const projected = await forkOpen.projectProviderMessage(msg);
              for (const event of projected) outbound.push(event);
              if (projected.some(isTerminalEvent)) break;
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
          const projectedOut = out as StreamAgentEvent;
          // Settle the outcome before yielding the terminal: a consumer that
          // stops on it goes straight to `finally`.
          const terminal = isTerminalEvent(out);
          if (terminal) {
            terminalAccounting = out.accounting;
            status = turnStatus({ terminal: out, stoppedByRome: false });
            terminalSeen = true;
          }
          // Relayed subagent blocks carry the child's agent tag; everything
          // else is this agent's own output.
          yield { ...projectedOut, agent: projectedOut.agent ?? this.key.agentName };
          if (terminal) break;
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
      // A consumer that abandons the stream before its terminal leaves the
      // turn with no outcome, which the lifecycle vocabulary calls stopped.
      this.deps.turnUsage.turnEnded({
        turnId,
        romeSessionId: forkSessionId,
        sessionKind: "fork",
        agentName: this.key.agentName,
        status: terminalSeen || status !== "completed" ? status : "stopped",
        provider: forkSession?.providerId ?? this.modelSession.providerId,
        model: forkSession?.model ?? this.modelSession.model,
        loginKind: forkSession ? forkLoginKind : sourceLoginKind,
        providerTurnId: forkModelTurnId,
        accounting: terminalAccounting,
        durationMs: Date.now() - startMs,
        finishedAt: new Date(),
      });
      // Before close(): a closed ModelSession no longer reports the thread this
      // needs. `terminalSeen` because `status` starts out "completed", so a
      // consumer that abandons the iterator would otherwise leave a resumable
      // row for a branch that produced nothing.
      if (
        forkSession &&
        opening &&
        !opening.oneShot &&
        keepsFork(opening, {
          completed: terminalSeen && status === "completed",
          modelThreadId: forkSession.modelThreadId,
          sourceModelThreadId,
        })
      ) {
        await this.persistForkThread(
          opening.continuityKey,
          forkSessionId,
          forkSession,
          forkReasoningEffort,
        );
      }
      // Best-effort: turn_end is the stream's true terminal, so a close-time
      // rejection must not escape to the consumer (and this finally also
      // runs when the consumer abandons the iterator early).
      if (forkSession) {
        try {
          await forkSession.close();
        } catch (err) {
          this.log.warn("forked session close failed", {
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
          this.log.warn("forked session child cleanup failed", {
            sessionId: this.sessionId,
            forkSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.activeForkedTurnCount = Math.max(0, this.activeForkedTurnCount - 1);
      this.activeForkSessionIds.delete(forkSessionId);
      this.lastActiveAt = Date.now();
      this.emitStatus();
      try {
        await this.touchSession();
      } catch (err) {
        this.log.warn("failed to touch source session after fork", {
          sessionId: this.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  addSubagentCall(toolUseId: string, call: SubagentCall): void {
    const sink = this.currentSink;
    if (!sink) throw new Error("Cannot attach a subagent without an active Parent turn");
    sink.subagentCallsByToolUse.set(toolUseId, {
      key: { parentSessionId: this.sessionId, turnId: sink.turnId, toolUseId },
      call,
    });
    this.maybePublishSubagentStart(sink, toolUseId);
  }

  private maybePublishSubagentStart(sink: TurnSink, toolUseId: string): void {
    if (sink.emittedSubagentStarts.has(toolUseId)) return;
    const use = sink.pendingSubagentToolUses.get(toolUseId);
    const linked = sink.subagentCallsByToolUse.get(toolUseId);
    if (!use || !linked) return;
    sink.emittedSubagentStarts.add(toolUseId);
    sink.pendingSubagentToolUses.delete(toolUseId);
    this.publishOutbound(sink, {
      type: "subagent_start",
      toolUseId,
      agentName: linked.call.subagent,
      input: use.input,
      sessionId: linked.call.sessionId,
      turnId: linked.call.turnId,
      ...(use.startedAt ? { startedAt: use.startedAt } : {}),
    });
  }

  submit(input: AgentTurnInput, options: SubmitOptions = {}): AgentInputReceipt {
    if (this.status === "closed") throw new Error(`AgentSession ${this.sessionId} is closed`);
    const { priority = "next", onInputStatus, ...turnOptions } = options;
    if (!isQueueInput(priority)) {
      const landed = afterLanding(this.turnMutex.isLocked());
      const handle = this.startTurn(input, turnOptions);
      return {
        ...(input.inputId ? { inputId: input.inputId } : {}),
        turnId: handle.id,
        landed,
        turn: Promise.resolve(handle),
      };
    }
    const receipt = this.inputs.submit(
      { ...input, inputId: input.inputId ?? uuidv7() },
      { ...turnOptions, priority, ...(onInputStatus ? { onInputStatus } : {}) },
    );
    // The queue ends its own turn. A system turn (a backend continuation) runs
    // outside the queue, so a `now` input ends it here.
    const sink = this.currentSink;
    if (
      priority === "now" &&
      sink &&
      !sink.done &&
      sink.turnId !== receipt.turnId &&
      !this.inputs.owns(sink.turnId)
    ) {
      void this.stopRunning(SUPERSEDED_INTERRUPT_REASON, sink.turnId).catch((error) =>
        this.log.warn("superseding the running turn failed", {
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return receipt;
  }

  /** Starts a turn behind the running one: an `after` input's, or the input queue's. */
  private startTurn(input: AgentTurnInput, options?: SendTurnOptions): AgentTurnHandle {
    if (this.status === "closed") {
      throw new Error(`AgentSession ${this.sessionId} is closed`);
    }
    // turnId is allocated here, at the bottom of the agent
    // stack, and threaded back to every consumer (route, tracing, IPC stream
    // channel name). No upper layer ever invents one — eliminates duplicate
    // / collision concerns by construction.
    const turnId = uuidv7();
    const { turn, writer } = createTurn(turnId, async (reason) => {
      if (sink.done) return;
      sink.lifecycleInterrupted = true;
      if (this.currentSink === sink) await this.stopRunning(reason);
    });
    const sink: TurnSink = {
      turnId,
      userPrompt: input.prompt,
      turnStartEmitted: false,
      writer,
      done: false,
      blocks: [],
      modelTurnStartMs: 0,
      ttftRecorded: false,
      romeAttrs: {},
      lifecycleParent: options?.lifecycleParent,
      threadContext: options?.threadContext,
      sharedContext: options?.sharedContext,
      romeSessionId: options?.romeSessionId ?? this.sessionId,
      replyTo: options?.replyTo,
      quoted: options?.quoted ?? null,
      initiatedBy: options?.initiatedBy ?? "user",
      pushLevel: options?.pushLevel,
      lifecycleFinishDispatched: false,
      lifecycleInterrupted: false,
      subagentCallsByToolUse: new Map(),
      pendingSubagentToolUses: new Map(),
      emittedSubagentStarts: new Set(),
      subagentLinksCleared: false,
      outputSchemaSuspended: false,
      usageRecorded: false,
    };

    // Open the per-turn `agent:*` root span here (not inside runOneTurn) so
    // it spans the turnMutex async seam — external callers can then wrap
    // post-turn work in `context.with(handle.turnContext, …)` and have it
    // land on the same trace. `links` carries an inbound request span when
    // startTurn is invoked with no active OTel context (the webchat POST
    // case); when invoked inside one (channel adapter path), that span
    // becomes the parent.
    // Identifying attrs stamped on every span this turn creates. We pass
    // them explicitly at each span-creation site (rather than via W3C
    // baggage on the context) so they never escape into outbound HTTP
    // headers the way baggage does under the default propagator.
    const romeAttrs: Attributes = {
      "agent.name": this.key.agentName,
      "session.id": this.sessionId,
      "turn.id": turnId,
      ...(this.key.channelThreadKey ? { "channel.thread_key": this.key.channelThreadKey } : {}),
      ...this.spanAttributes,
    };
    sink.romeAttrs = romeAttrs;

    const span = trace.getTracer("rome").startSpan(`agent:${this.key.agentName}`, {
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

    this.turns.add(turn);
    return Object.assign(turn, { turnContext: turnCtx });
  }

  private async runOneTurn(
    turnId: string,
    input: AgentTurnInput,
    sink: TurnSink,
    turnCtx: Context,
  ): Promise<void> {
    const span = trace.getSpan(turnCtx)!;
    if (this.status === "closed") {
      // startTurn opened the span before this check could run; close it
      // here since no other path on this branch will.
      span.setStatus({ code: SpanStatusCode.ERROR, message: "AgentSession closed" });
      span.end();
      this.failTurn(sink, "AgentSession closed");
      return;
    }
    // Only this turn's own position is a place to branch at, and it may leave none.
    this.lastPosition = undefined;
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
      this.deps.sessionTracing.startSpan("model.turn", {
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
      // Per-turn session_init: trace/UI headers (AgentCallView, showcases'
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
      let unseenMessageIds: number[] = [];
      // The agent catches up on the messages said where its session stands
      // that no turn of it took, gave or saw (docs/domains/participation.md#projection).
      // The prompt facts answer null where it catches up on nothing.
      const unseen =
        this.kind === "conversation" && sink.threadContext
          ? (this.deps.promptFacts?.unseen(sink.romeSessionId) ?? null)
          : null;
      if (unseen) {
        unseenMessageIds = unseen.map((message) => message.id);
        userPrompt = catchUpPrompt(userPrompt, {
          unseen,
          quoted: sink.quoted,
          replyTo: sink.replyTo,
        });
      }
      // Every turn, subagents included: the folder is where the work happens.
      const deviceFolderBlock = buildDeviceFolderBlock(tc);
      if (deviceFolderBlock) {
        userPrompt = `${deviceFolderBlock}\n\n${userPrompt}`;
      }
      if (!this.isSubagent && this.continuationPending) {
        sink.carriesContinuation = true;
        const previousModel =
          this.previousModel && this.previousModel !== this.modelSession.model
            ? this.previousModel
            : undefined;
        const block = buildContinuationBlock({
          ...(previousModel ? { previousModel } : {}),
          canReadHistory: this.mayCall(FETCH_CHANNEL_HISTORY_ACTION),
        });
        userPrompt = `${block}\n\n${userPrompt}`;
      }
      // A thread that starts in this session, the first one or one that
      // replaced it on another provider, has not seen the block yet.
      if (!this.isSubagent && this.threadFresh && !this.threadContextInjected && tc) {
        this.threadContextInjected = true;
        const workingPath = this.workingDir?.trim();
        const block = buildThreadContextBlock(tc, {
          path: workingPath,
          relativePath: workingPath ? projectPath(this.deps.folders, workingPath) : null,
        });
        if (block) {
          userPrompt = `${block}\n\n${userPrompt}`;
        }
      }
      const initMsg: AgentEvent = {
        type: "session_init",
        sessionId: this.sessionId,
        systemPrompt: this.systemPrompt,
        userPrompt,
        projectPath: tc?.projectPath,
        turnId,
      };
      this.publishOutbound(sink, initMsg);

      // Turn-middleware onion. App middlewares wrap the act of
      // producing this turn's reply; the real model call is fixed innermost and runs only when every
      // middleware calls next(). A middleware that short-circuits — e.g.
      // a scripted conversation — emits its own model-isomorphic
      // content events via ctx.emit and the model is never touched. Bracketing
      // (turn_start/turn_end) and status stay on this wrapper, so a scripted
      // turn closes exactly like a model turn and the downstream SSE/persistence
      // pipeline can't tell them apart.
      const mwInput = { prompt: userPrompt, reasoningEffort: input.reasoningEffort };
      let emittedTerminal: TurnResultEvent | TurnErrorEvent | undefined;
      let droppedAfterTerminal = false;
      let droppedDuringModel = false;
      let modelRan = false;
      const mwTurn: Parameters<TurnMiddleware["run"]>[0] = {
        sessionId: this.sessionId,
        agentName: this.key.agentName,
        continuityKey: this.key.channelThreadKey,
        input: mwInput,
        emit: (event) => {
          if (sink.done) return;
          // A middleware's first terminal ends its stream, as the model's
          // terminal does on the model path, so it publishes exactly one.
          if (emittedTerminal) {
            if (!droppedAfterTerminal) {
              droppedAfterTerminal = true;
              this.log.warn("turn middleware emitted after its terminal event; dropping the rest", {
                sessionId: this.sessionId,
                agentName: this.key.agentName,
                turnId,
                eventType: event.type,
              });
            }
            return;
          }
          // Once next() starts the model, the model owns the stream, so any
          // middleware emit from then on is dropped, whether it comes from an
          // unawaited next() or from a task the middleware started earlier.
          if (modelRan) {
            if (!droppedDuringModel) {
              droppedDuringModel = true;
              this.log.warn("turn middleware emitted while the model was running; dropping it", {
                sessionId: this.sessionId,
                agentName: this.key.agentName,
                turnId,
                eventType: event.type,
              });
            }
            return;
          }
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
      };

      // The events loop closes the sink on the model's `result`/`error`.
      const waitForSinkClose = async (): Promise<void> => {
        if (sink.done) return;
        await new Promise<void>((resolve) => {
          const checker = setInterval(() => {
            if (sink.done) {
              clearInterval(checker);
              resolve();
            }
          }, 5);
        });
      };

      const runModelTerminal = async (): Promise<void> => {
        if (sink.done) return;
        if (emittedTerminal) {
          // Reached through next() after an emit, or through the chain's
          // fail-open next() after a throw. A model run would publish a second
          // terminal and pay for a second reply.
          this.log.warn(
            "turn middleware continued to the model after its terminal event; skipped",
            {
              sessionId: this.sessionId,
              agentName: this.key.agentName,
              turnId,
            },
          );
          return;
        }
        if (sink.lifecycleInterrupted) {
          await this.modelSession.interrupt("user-stop");
          this.finalizeTurn(sink, { type: "result", content: "" });
          return;
        }
        modelRan = true;
        try {
          await context.with(turnCtx, async () => {
            await this.inputs.beforeSend(turnId);
            // The login kind this turn is sent under; Codex holds a queued turn to it.
            sink.loginKind = this.modelSession.loginKind;
            await this.modelSession.sendUserInput({
              inputId: input.inputId,
              text: mwInput.prompt,
              images: input.images,
              reasoningEffort: mwInput.reasoningEffort,
            });
            // Taking the input may have replaced a Claude query, and its login kind.
            sink.loginKind = this.modelSession.loginKind;
            this.inputs.ready(turnId);
            if (this.deps.promptFacts && unseenMessageIds.length > 0) {
              try {
                this.deps.promptFacts.seen(unseenMessageIds, sink.romeSessionId, sink.turnId);
              } catch (err) {
                // As below: the turn goes on, and a later turn retries.
                this.log.warn("failed to mark conversation context seen", {
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

        await waitForSinkClose();
      };

      const chain = this.deps.turnMiddleware;
      if (chain) {
        try {
          await chain.run(mwTurn, runModelTerminal);
        } catch (err) {
          // A fail-closed throw after the terminal, or after next() started
          // the model, cannot change the outcome, so the turn ends on the
          // terminal already emitted or on the model's.
          if (!emittedTerminal && !modelRan) throw err;
          if (err instanceof Error && this.currentAgentSpan === span) span.recordException(err);
          this.log.warn(
            "turn middleware threw after its terminal event or after starting the model",
            {
              sessionId: this.sessionId,
              agentName: this.key.agentName,
              turnId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      } else {
        await runModelTerminal();
      }
      // A middleware that did not await next() returns while the model is
      // still running. The model's terminal ends the turn, not a synthesized one.
      if (modelRan) await waitForSinkClose();

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
        let terminal: TurnResultEvent | TurnErrorEvent = emittedTerminal ?? {
          type: "result",
          content: "",
        };
        // A middleware that short-circuits without a terminal, such as a turn
        // parked on a question card, still publishes one. An interrupted turn
        // publishes none, as an interrupt before the model starts does.
        if (!emittedTerminal && !sink.lifecycleInterrupted) {
          terminal = validateProviderStructuredResult(
            terminal,
            this.structuredOutputValidator,
            sink.outputSchemaSuspended,
          ) as TurnResultEvent | TurnErrorEvent;
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
        this.deps.turnUsage.turnTimed(this.key.agentName, Date.now() - this.currentTurnStartMs);
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

  async stop(reason?: string): Promise<void> {
    await this.stopRunning(reason);
  }

  /** Stops the running turn, or only the turn `expectedTurnId` when one is named. */
  private async stopRunning(reason?: string, expectedTurnId?: string): Promise<void> {
    const sink = this.currentSink;
    if (!sink || sink.done || (expectedTurnId && sink.turnId !== expectedTurnId)) return;
    sink.lifecycleInterrupted = true;
    // Cancel the provider before awaiting child cleanup. A slow child must
    // not keep its parent generating after the user presses Stop.
    await Promise.all([
      this.modelSession.interrupt(reason),
      Promise.allSettled(
        [...sink.subagentCallsByToolUse.values()].map(({ call }) => call.cancel(reason)),
      ),
    ]);
  }

  async close(reason: "idle" | "shutdown" | "error" | "user"): Promise<void> {
    if (this.closingPromise) return await this.closingPromise;
    if (this.status === "closed") return;
    this.inputs.close();
    this.closingPromise = (async () => {
      this.log.info("agent session closing", {
        sessionId: this.sessionId,
        agentName: this.key.agentName,
        reason,
      });
      const currentSink = this.currentSink;
      if (currentSink) {
        await Promise.allSettled(
          [...currentSink.subagentCallsByToolUse.values()].map(({ call }) =>
            call.cancel(`Parent session closed: ${reason}`),
          ),
        );
      }
      try {
        await this.modelSession.close();
      } catch (err) {
        this.log.warn("modelSession close threw", {
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

/** The subagents this agent may hand work to, as its definition names them. */
function subagentsOf(agents: AgentCatalog, config: AgentDefinition): Subagent[] {
  return (config.allowedSubagents ?? []).map((name) => ({
    name,
    description: requireAgent(agents, name).definition.description,
  }));
}
