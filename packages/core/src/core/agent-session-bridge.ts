// Main-process AgentSession bridge. Session model: docs/concepts/sessions.md.
// Exposes AgentSessionManager to forked
// workers over IpcRpc. Workers call `agent.session.runTurn` and consume the
// returned `agent.turn:<turnId>` stream.

import { canOpen } from "../concierge/privacy.js";
import { readerOwner } from "../chats/dashboard/dashboard-account.js";
import type { ChildProcess } from "node:child_process";
import type { IpcCallContext, IpcRpc } from "../actions/ipc.js";
import { walkToRoot } from "../agent/index.js";
import { parseSessionKey } from "./agent-session-key.js";
import type {
  ChatId,
  CurrentActionContext,
  MessageReplyReference,
  RomeSessionRef,
  StreamAgentEvent,
} from "@rome-os/app-runtime";
import type {
  AgentSessionInit,
  AgentSessionKey,
  AgentSessionManager,
  AgentSession,
  AgentTurnHandle,
  AgentTurnInput,
} from "./agent-session.js";
import { createLogger } from "../logger.js";
import { runWithHookInvocationContext, type HookInvocationContext } from "./hook-recursion.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import {
  AgentTraceRecorder,
  recordAgentTraceBestEffort,
  resolveTurnConversation,
  shouldPersistAgentTrace,
} from "./agent-trace-recorder.js";
import {
  type ActionWorkerCoordinator,
  registerActionSubprocessHost,
} from "../actions/action-subprocess.js";
import type { AgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import { resolveProjectWorkingDirWithinRoot } from "../webchat/projects.js";
import { runLines, type RunLineDeps } from "../connections/speaker-messages.js";
import { findSessionChat } from "./session-conversation.js";

const log = createLogger("agent-session-bridge");

const WORKER_DISCONNECTED_REASON = "action worker disconnected";

/** The one action whose agent runs inherit the calling session's project. */
const SUMMON_ACTION = "system:summon";

export interface RunTurnRequest {
  key: AgentSessionKey;
  init?: AgentSessionInit;
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
 * Bridge wires `AgentSessionManager` into a worker child's IPC channel.
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
    private manager: AgentSessionManager,
    private webchatRepo?: WebChatRepository,
    private actionWorkerCoordinator?: ActionWorkerCoordinator,
    private turnStreams?: AgentTurnStreamRegistry,
    /** Root that worker-requested working dirs must stay inside. Defaults to the profile's projects root. */
    private projectsRoot?: string,
    /** Chats' lines a run names by the platform's ids. Given, a recorded
     *  prompt becomes its turn's through Chats' turn links, not
     *  `webchatRepo`'s rows. */
    private runLineDeps?: RunLineDeps,
  ) {}

  /**
   * Whether the action that asked to resume `session` may: every dashboard
   * chat the session runs in (its own, its parent's, a fork's or subagent's
   * row) must exist and be one its caller may open.
   */
  private async callerMayResume(
    session: AgentSession,
    named: string | undefined,
    ctx: IpcCallContext,
  ): Promise<boolean> {
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
    if (!named) {
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
        const init = {
          ...req.init,
          workingDir,
          isSubagent: true,
          applyProviderSessionReset: Boolean(req.platformMessageId),
        };
        const acquireStartedAt = Date.now();
        log.info("agent.session.manager.acquire started", baseLogFields);

        let session: AgentSession;
        try {
          session = req.sessionId
            ? await this.manager.acquireBySessionId(req.sessionId, req.key.agentName, init)
            : await this.manager.acquire(req.key, init);
          // A session resumed by its id runs in its own chats, so the caller
          // must be one who may open them, as on the dashboard's routes.
          if (
            req.sessionId &&
            !(await this.callerMayResume(session, req.init?.romeSessionId, ctx))
          ) {
            throw new Error(`Agent session "${req.sessionId}" was not found`);
          }
        } catch (err) {
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

        const conversation = resolveTurnConversation({
          agentName: req.key.agentName,
          agentSessionId: session.sessionId,
          romeSessionId: req.init?.romeSessionId,
          sessionChat: req.init?.romeSessionId
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
          ? await runLines(this.runLineDeps.lines, romeSessionId, req)
          : null;

        // sendTurn is sync — turnId returned immediately,
        // events drain in the background as the turn runs.
        const handle = session.sendTurn(req.input, {
          threadContext: req.init?.threadContext,
          sharedContext: req.init?.sharedContext,
          romeSessionId,
          romeSessionType,
          replyTo: req.replyTo,
          ...(lines ? { quoted: lines.quoted } : {}),
        });
        const turnLogFields = {
          ...baseLogFields,
          sessionId: session.sessionId,
          turnId: handle.turnId,
        };
        const workerWatch = interruptTurnOnWorkerDisconnect(rpc, session, handle, turnLogFields);
        try {
          this.runLineDeps?.replies?.runs(handle.turnId, req.key.agentName);
          if (lines && this.runLineDeps) {
            if (conversation.promptPersisted && lines.prompt !== null) {
              this.runLineDeps.links.prompt(lines.prompt, romeSessionId, handle.turnId);
            }
          } else if (this.webchatRepo && conversation.promptPersisted && req.platformMessageId) {
            await this.webchatRepo.assignConversationMessageTurn(
              romeSessionId,
              req.platformMessageId,
              handle.turnId,
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
                turnId: handle.turnId,
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
          turnId: handle.turnId,
          durationMs: Date.now() - requestStartedAt,
        });

        const { interrupt } = handle;

        const stream = ctx.openStream<StreamAgentEvent>(`agent.turn:${handle.turnId}`);
        // Drain the per-turn events into the IPC stream.
        void (async () => {
          let liveStream: ReturnType<AgentTurnStreamRegistry["register"]> | null = null;
          try {
            for await (const msg of handle.events) {
              // Recorded first, so a turn that opens its conversation has its
              // row before its stream can be asked for.
              if (recorder) {
                await recordAgentTraceBestEffort(recorder, msg, log, {
                  turnId: handle.turnId,
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
                    agentName: session.key.agentName,
                    ...(thread?.connectionId
                      ? {
                          conversation: {
                            connectionId: thread.connectionId,
                            chatId: thread.threadId as ChatId,
                          },
                        }
                      : {}),
                    ...(thread?.channelUserId ? { initiatorId: thread.channelUserId } : {}),
                    interrupt,
                  });
                } catch (err) {
                  log.warn("failed to register agent turn stream", {
                    turnId: handle.turnId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
              liveStream?.publish(msg);
              stream.send(msg);
            }
            stream.close();
          } catch (err) {
            log.warn("error draining agent turn into IPC stream", {
              turnId: handle.turnId,
              error: err instanceof Error ? err.message : String(err),
            });
            stream.close({ error: err instanceof Error ? err : new Error(String(err)) });
          } finally {
            workerWatch.release();
            liveStream?.finish();
          }
        })();

        return { turnId: handle.turnId, sessionId: session.sessionId, romeSession };
      });
    });

    rpc.handle<{ key: AgentSessionKey; reason?: string }, { ok: true }>(
      "agent.session.interrupt",
      async (req) => {
        const sess = this.manager.peek(req.key);
        if (sess) {
          await sess.interrupt(req.reason);
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
  session: AgentSession,
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
        await (handle.interrupt
          ? handle.interrupt(reason)
          : session.interrupt(reason, handle.turnId));
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
