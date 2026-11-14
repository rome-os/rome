// Main-process AgentSession bridge. Session model: docs/concepts/sessions.md.
// Exposes Sessions to forked
// workers over IpcRpc. Workers call `agent.session.runTurn` and consume the
// returned `agent.turn:<turnId>` stream.

import { canOpen } from "../webchat/privacy.js";
import { readerOwner } from "../webchat/dashboard-account.js";
import type { ChildProcess } from "node:child_process";
import type { IpcCallContext, IpcRpc } from "../apps/actions/ipc.js";
import { walkToRoot } from "../agent/index.js";
import { parseSessionKey } from "./agent-session-key.js";
import type {
  ChatId,
  ChatRef,
  CurrentActionContext,
  MessageReplyReference,
  RomeSessionRef,
  StreamAgentEvent,
} from "@rome-os/app-runtime";
import type {
  SessionOpening,
  AgentSessionKey,
  Sessions,
  AgentSession,
  AgentTurnHandle,
  AgentTurnInput,
} from "../agent/index.js";
import { createLogger } from "../logger.js";
import { type ChatResetPolicy, resetPolicyOfMessage } from "./chat-reset-policy.js";
import { type SessionOpeningFor, sessionOpeningFor } from "./session-opening.js";
import { runWithHookInvocationContext, type HookInvocationContext } from "./hook-recursion.js";
import type { WebChatRepository } from "../webchat/repository.js";
import {
  AgentTraceRecorder,
  recordAgentTraceBestEffort,
  resolveTurnConversation,
  shouldPersistAgentTrace,
} from "./agent-trace-recorder.js";
import {
  type ActionWorkerCoordinator,
  registerActionSubprocessHost,
} from "../apps/actions/action-subprocess.js";
import type { AgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import { resolveProjectWorkingDirWithinRoot } from "../webchat/projects.js";
import { runLines, type RunLineDeps } from "../connections/speaker-messages.js";
import {
  findSessionChat,
  noteOpenerChat,
  openedInChat,
  openerChat,
  withRomeSession,
} from "./session-conversation.js";

const log = createLogger("agent-session-bridge");

const WORKER_DISCONNECTED_REASON = "action worker disconnected";

/** The one action whose agent runs inherit the calling session's project. */
const SUMMON_ACTION = "system:summon";

export interface RunTurnRequest {
  key: AgentSessionKey;
  init?: Omit<
    SessionOpening,
    "resetPolicy" | "drawsCards" | "guardianFacing" | "toolEnv" | "spanAttributes"
  > & {
    /** The chat the caller names, which the bridge records as having the session. */
    romeSessionId?: string;
  };
  input: AgentTurnInput;
  platformMessageId?: string;
  replyTo?: MessageReplyReference;
  sessionId?: string;
  hookInvocationContext?: HookInvocationContext;
  actionContext?: CurrentActionContext;
}

export interface RunTurnResponse {
  turnId: string;
  sessionId: string;
  romeSession: RomeSessionRef;
}

export const AGENT_SESSION_RUN_TURN_TIMEOUT_MS = 10 * 60_000;

/** A process that can expose the agent-session IPC surface to a child. */
export interface AgentSessionChildBridge {
  attach(rpc: IpcRpc, child: ChildProcess): void;
}

/**
 * Told that a turn started in a connected account's chat, with the platform
 * user whose message started it. The returned call is told when it ends.
 */
export type TurnStartedInChat = (
  chat: ChatRef,
  turn: { turnId: string; initiatorId?: string },
) => () => void;

/**
 * Bridge wires `Sessions` into a worker child's IPC channel.
 * Constructed once in main; call `attach(rpc, child)` for each forked worker.
 *
 * The bridge registers `agent.session.runTurn` on the child's IpcRpc. The
 * handler resolves to `{ turnId, sessionId, romeSession }`, and the worker subscribes to the named
 * stream `agent.turn:<turnId>` to receive AgentMessages.
 *
 * A turn started over the bridge lives only as long as the worker that asked
 * for it. When that worker's IpcRpc disconnects (the child crashes, exits, or
 * is killed by action cancellation), the bridge interrupts every turn the
 * worker started that has not ended, so it finishes `interrupted`.
 */
export class AgentSessionBridge implements AgentSessionChildBridge {
  constructor(
    private manager: Sessions,
    private webchatRepo?: WebChatRepository,
    private actionWorkerCoordinator?: ActionWorkerCoordinator,
    private turnStreams?: AgentTurnStreamRegistry,
    /** Root that worker-requested working dirs must stay inside. Defaults to the profile's projects root. */
    private projectsRoot?: string,
    /** Chats' lines a run names by the platform's ids. Given, a recorded
     *  prompt becomes its turn's through Chats' turn links, not
     *  `webchatRepo`'s rows. */
    private runLineDeps?: RunLineDeps,
    /** The reset policy of a connected account's chat. Absent, no session is reset. */
    private resetPolicyOf?: ChatResetPolicy,
    /** What this opener states for a session it opens. Absent, no channel shows cards. */
    private openingFor: SessionOpeningFor = sessionOpeningFor({
      channelSurface: () => null,
    }),
    /** Told when a turn starts in a connected account's chat. Absent, nobody is told. */
    private turnStartedInChat?: TurnStartedInChat,
  ) {}

  /**
   * Whether the action that asked to resume `session` may: every dashboard
   * chat the session runs in (its own, its parent's, a fork's or subagent's
   * row) must exist and be one its caller may open.
   */
  private async callerMayResume(session: AgentSession, ctx: IpcCallContext): Promise<boolean> {
    if (!this.webchatRepo) return true;
    const repo = this.webchatRepo;
    const caller = ctx.callerActionContext;
    const thread = caller?.channelContext;
    const owner = await readerOwner(repo, {
      actor: caller?.actor,
      chatId: thread?.channel === "webchat" && thread.threadId ? thread.threadId : null,
    });
    const required: string[] = [];
    const known = new Set<string>([session.sessionId]);
    // Checked only when the session's opener named no chat, as when the
    // session held its chat itself (temporary, ZHA-157).
    if (!openerChat(session)) {
      const chat = await findSessionChat(repo, session.sessionId);
      if (chat) known.add(chat.id);
    }
    const root = walkToRoot(session.key.channelThreadKey);
    for (const forkSessionId of root.forkSessionIds) known.add(forkSessionId);
    const rootKey = parseSessionKey(root);
    if (rootKey.kind === "webchat") required.push(rootKey.chatId);
    for (const chatId of required) {
      const chat = await repo.getSession(chatId);
      if (!chat || !canOpen(chat, owner)) return false;
    }
    for (const chatId of known) {
      const chat = await repo.getSession(chatId);
      if (chat && !canOpen(chat, owner)) return false;
    }
    return true;
  }

  attach(rpc: IpcRpc, child: ChildProcess): void {
    if (this.actionWorkerCoordinator) {
      registerActionSubprocessHost(rpc, this.actionWorkerCoordinator, child);
    }

    rpc.handle<RunTurnRequest, RunTurnResponse>("agent.session.runTurn", async (req, ctx) => {
      return await runWithHookInvocationContext(req.hookInvocationContext, async () => {
        const requestStartedAt = Date.now();
        const acquireMode = req.sessionId ? "sessionId" : "key";
        const baseLogFields = {
          agent: req.key.agentName,
          channelThreadKey: req.key.channelThreadKey,
          requestedSessionId: req.sessionId,
          acquireMode,
        };

        log.info("agent.session.runTurn received", baseLogFields);

        let workingDir: string | undefined;
        try {
          workingDir = await this.resolveRunWorkingDir(req);
        } catch (err) {
          log.warn("agent.session.runTurn rejected working dir", {
            ...baseLogFields,
            requestedWorkingDir: req.init?.workingDir,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }

        // Every run over this bridge is a forked action worker asking main to
        // run an agent — a nested subagent run (e.g. blocking `summon`) by
        // construction. Mark it so `rome.session.acquire` labels these opens
        // `is_subagent=true`; the top-level manager itself is `isSubagent=false`.
        const { romeSessionId: namedChat, ...sessionInit } = req.init ?? {};
        const acquireStartedAt = Date.now();
        log.info("agent.session.manager.acquire started", baseLogFields);

        let session: AgentSession;
        // Held from the acquire until the turn is submitted; a failure before
        // that lets it go (docs/concepts/sessions.md#session-in-use).
        let acquired: AgentSession | undefined;
        try {
          const openedKey = req.sessionId
            ? await this.webchatRepo?.continuityKeyOfSession(req.sessionId)
            : req.key.channelThreadKey;
          const opening = {
            ...sessionInit,
            // Stated here, never taken from the worker's request.
            ...this.openingFor(openedKey ?? "", sessionInit.threadContext),
            kind: sessionInit.threadContext ? ("conversation" as const) : ("action" as const),
            workingDir,
            isSubagent: true,
          };
          session = req.sessionId
            ? await this.manager.resume({ id: req.sessionId, agent: req.key.agentName }, opening)
            : await this.manager.open(
                // Only the key's own fields, never the rest of the worker's request.
                { agentName: req.key.agentName, channelThreadKey: req.key.channelThreadKey },
                {
                  ...opening,
                  // Read here, never taken from the worker's request.
                  resetPolicy: await resetPolicyOfMessage(this.resetPolicyOf, {
                    platformMessageId: req.platformMessageId,
                    threadContext: sessionInit.threadContext,
                  }),
                },
              );
          acquired = session;
          noteOpenerChat(session, namedChat);
          // A session resumed by its id runs in its own chats, so the caller
          // must be one who may open them, as on the dashboard's routes.
          if (req.sessionId && !(await this.callerMayResume(session, ctx))) {
            throw new Error(`Agent session "${req.sessionId}" was not found`);
          }
          // An action's worker may only fill a link the session lacks, never
          // move one, and only once the check above has passed.
          await openedInChat(this.webchatRepo, session, namedChat, { replace: false });
        } catch (err) {
          acquired?.release();
          log.warn("agent.session.manager.acquire failed", {
            ...baseLogFields,
            durationMs: Date.now() - acquireStartedAt,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }

        log.info("agent.session.manager.acquire completed", {
          ...baseLogFields,
          sessionId: session.sessionId,
          durationMs: Date.now() - acquireStartedAt,
        });

        const prepared = await (async () => {
          const conversation = resolveTurnConversation({
            agentName: req.key.agentName,
            agentSessionId: session.sessionId,
            romeSessionId: namedChat,
            openerChat: openerChat(session),
            sessionChat:
              (openerChat(session) ?? namedChat)
                ? undefined
                : await findSessionChat(this.webchatRepo, session.sessionId),
            channelThreadKey: req.key.channelThreadKey,
            threadContext: req.init?.threadContext,
            actionContext: req.actionContext,
          });
          const { romeSessionId, romeSessionType } = conversation;
          const romeSession: RomeSessionRef = {
            _romeSessionId: romeSessionId,
            _type: romeSessionType,
          };

          // The line the run names by its platform id, which the turn answers,
          // and the one its reply quotes, as Chats holds them.
          const lines = this.runLineDeps
            ? await runLines(this.runLineDeps.lines, this.runLineDeps.labels, romeSessionId, req)
            : null;
          return { conversation, romeSessionId, romeSession, lines };
        })().catch((err: unknown) => {
          session.release();
          throw err;
        });
        const { conversation, romeSessionId, romeSession, lines } = prepared;

        // An app's turn waits behind the running one; its events drain in the
        // background as it runs.
        // The person the calling action acts for, as the IPC boundary captured
        // it: the turn's tool calls act for them too.
        const actor = ctx.callerActionContext?.actor;
        const handle = await session.submit(req.input, {
          priority: "after",
          ...(actor ? { actor } : {}),
          threadContext: req.init?.threadContext,
          sharedContext: req.init?.sharedContext,
          romeSessionId,
          replyTo: req.replyTo,
          ...(lines ? { quoted: lines.quoted, current: lines.current } : {}),
        }).turn;
        const turnLogFields = {
          ...baseLogFields,
          sessionId: session.sessionId,
          turnId: handle.id,
        };
        const workerWatch = interruptTurnOnWorkerDisconnect(rpc, handle, turnLogFields);
        try {
          this.runLineDeps?.replies?.runs(handle.id, req.key.agentName);
          if (lines && this.runLineDeps) {
            if (conversation.promptPersisted && lines.prompt !== null) {
              this.runLineDeps.links.prompt(lines.prompt, romeSessionId, handle.id);
            }
          } else if (this.webchatRepo && conversation.promptPersisted && req.platformMessageId) {
            await this.webchatRepo.assignConversationMessageTurn(
              romeSessionId,
              req.platformMessageId,
              handle.id,
            );
          }
        } catch (err) {
          // The drain loop below never starts, so nothing would read this
          // turn's events and the worker never learns its turnId.
          workerWatch.interrupt("agent turn setup failed");
          throw err;
        }

        const thread = req.init?.threadContext;

        const recorder =
          this.webchatRepo && shouldPersistAgentTrace(req.init?.threadContext)
            ? new AgentTraceRecorder({
                webchatRepo: this.webchatRepo,
                agentName: req.key.agentName,
                agentSessionId: session.sessionId,
                romeSessionId,
                existingSessionId: conversation.existing ? romeSessionId : undefined,
                channelThreadKey: req.key.channelThreadKey,
                turnId: handle.id,
                threadContext: req.init?.threadContext,
                actionContext: req.actionContext,
                persistTranscript: true,
                persistUserTranscript: !conversation.promptPersisted,
                // Where the session stands in a chat, the caller records the
                // answer as it sends it, so the recorder writing it too would
                // say it twice, or say one that never went out.
                persistAssistantTranscript: !this.runLineDeps?.lines.stands(romeSessionId),
              })
            : null;

        log.info("agent.session.runTurn response ready", {
          ...baseLogFields,
          sessionId: session.sessionId,
          turnId: handle.id,
          durationMs: Date.now() - requestStartedAt,
        });

        const stream = ctx.openStream<StreamAgentEvent>(`agent.turn:${handle.id}`);
        // Drain the per-turn events into the IPC stream.
        void (async () => {
          let liveStream: ReturnType<AgentTurnStreamRegistry["register"]> | null = null;
          let endChatTurn: (() => void) | null = null;
          try {
            for await (const event of handle.events()) {
              const msg = withRomeSession(event, romeSession);
              // Recorded first, so a turn that opens its conversation has its
              // row before its stream can be asked for.
              if (recorder) {
                await recordAgentTraceBestEffort(recorder, msg, log, {
                  turnId: handle.id,
                  source: "agent-session-bridge",
                });
              }
              if (!liveStream && msg.type === "turn_start" && this.turnStreams) {
                try {
                  liveStream = this.turnStreams.register({
                    sessionId: msg.sessionId,
                    // The conversation the turn is recorded in; the session id
                    // is the agent's runtime session, not a chat.
                    chatId: romeSessionId,
                    turnId: msg.turnId,
                  });
                  if (thread?.connectionId && this.turnStartedInChat) {
                    endChatTurn = this.turnStartedInChat(
                      { connectionId: thread.connectionId, chatId: thread.threadId as ChatId },
                      {
                        turnId: msg.turnId,
                        ...(thread.channelUserId ? { initiatorId: thread.channelUserId } : {}),
                      },
                    );
                  }
                } catch (err) {
                  log.warn("failed to register agent turn stream", {
                    turnId: handle.id,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
              stream.send(msg);
            }
            stream.close();
          } catch (err) {
            log.warn("error draining agent turn into IPC stream", {
              turnId: handle.id,
              error: err instanceof Error ? err.message : String(err),
            });
            stream.close({ error: err instanceof Error ? err : new Error(String(err)) });
          } finally {
            workerWatch.release();
            liveStream?.finish();
            endChatTurn?.();
          }
        })();

        return { turnId: handle.id, sessionId: session.sessionId, romeSession };
      });
    });

    rpc.handle<{ key: AgentSessionKey; reason?: string }, { ok: true }>(
      "agent.session.interrupt",
      async (req) => {
        const sess = this.manager.find(req.key);
        if (sess) {
          await sess.stop(req.reason);
        }
        return { ok: true };
      },
    );
  }

  /**
   * The worker names a working dir from app code, so an explicit one must
   * resolve inside the projects root. Without one, a new `summon` run inherits
   * the working dir of the open agent session whose action asked for it, as
   * `execute_subagent` inherits its parent's. Summon sends no channel-thread
   * key, so a summon run without a `sessionId` always opens a new session.
   * Every other run, and every resume, gets no dir from here: the manager
   * reopens a resumed session where its transcript was written, else uses the
   * default project.
   */
  private async resolveRunWorkingDir(req: RunTurnRequest): Promise<string | undefined> {
    const requested = req.init?.workingDir;
    if (requested !== undefined) {
      return await resolveProjectWorkingDirWithinRoot(requested, this.projectsRoot);
    }
    if (req.sessionId || req.actionContext?.actionName !== SUMMON_ACTION) return undefined;
    const callerSessionId = req.actionContext?.sessionId;
    return callerSessionId ? this.manager.findWorkingDirBySessionId(callerSessionId) : undefined;
  }
}

interface TurnWorkerWatch {
  /** Stops watching. Call once the turn has ended. */
  release(): void;
  /** Interrupts the turn now and stops watching, so a later disconnect does not interrupt it again. */
  interrupt(reason: string): void;
}

/**
 * Interrupts `handle`'s turn when `rpc` disconnects. A worker that already
 * disconnected still gets its turn interrupted, because `IpcRpc.onDisconnect`
 * runs a late subscriber on the next microtask. Never throws: an interrupt
 * that fails is logged.
 */
function interruptTurnOnWorkerDisconnect(
  rpc: IpcRpc,
  handle: AgentTurnHandle,
  logFields: Record<string, unknown>,
): TurnWorkerWatch {
  let watching = true;
  let offDisconnect: () => void = () => undefined;
  const interrupt = (reason: string): void => {
    if (!watching) return;
    watching = false;
    offDisconnect();
    log.info("interrupting agent turn", { ...logFields, reason });
    void (async () => {
      try {
        await handle.stop(reason);
      } catch (err) {
        log.warn("failed to interrupt agent turn", {
          ...logFields,
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  };
  offDisconnect = rpc.onDisconnect(() => interrupt(WORKER_DISCONNECTED_REASON));
  return {
    release: () => {
      watching = false;
      offDisconnect();
    },
    interrupt,
  };
}
