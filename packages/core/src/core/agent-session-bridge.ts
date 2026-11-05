// Main-process AgentSession bridge. Session model: docs/concepts/sessions.md.
// Exposes AgentSessionManager to forked
// workers over IpcRpc. Workers call `agent.session.runTurn` and consume the
// returned `agent.turn:<turnId>` stream.

import type { ChildProcess } from "node:child_process";
import type { IpcRpc } from "../actions/ipc.js";
import type {
  ChatId,
  CurrentActionContext,
  MessageReplyReference,
  StreamAgentEvent,
} from "@rome-os/app-runtime";
import type {
  AgentSessionManager,
  AgentSession,
  AgentTurnHandle,
  AgentTurnInput,
} from "../agent-sessions/index.js";
import { withTurnExecution } from "../agent-sessions/index.js";
import { createLogger } from "../logger.js";
import { runWithHookInvocationContext, type HookInvocationContext } from "./hook-recursion.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import {
  type ActionWorkerCoordinator,
  registerActionSubprocessHost,
} from "../actions/action-subprocess.js";
import type { AgentTurnStreamRegistry } from "../agent-sessions/index.js";
import { resolveProjectWorkingDirWithinRoot } from "../webchat/projects.js";
import { linkPromptToTurn, runLines, type RunLineDeps } from "../connections/speaker-messages.js";
import { sessionSurfaceOf } from "../connections/session-surface.js";
import { callerChatId, callerKey, type SessionCaller } from "./session-caller.js";
import { rememberedChatModel } from "./chat-model-selection.js";
import { openNamed } from "../agent-sessions/index.js";
import type { ThreadContext } from "./types.js";
import { channelChatId } from "../db/session-kind.js";
import { catchUpBriefing } from "./connection-briefing.js";
import { resetWhenDue } from "./connection-reset.js";
import type { WakeDeps } from "./agent-runner.js";

const log = createLogger("agent-session-bridge");

const WORKER_DISCONNECTED_REASON = "action worker disconnected";

/** The one action whose agent runs inherit the calling session's project. */
const SUMMON_ACTION = "system:summon";

/** The session a worker's run names: the agent and the caller, as the
 *  worker holds it. */
export interface RunTurnKey {
  agentName: string;
  caller: SessionCaller;
}

export interface RunTurnRequest {
  key: RunTurnKey;
  init?: { workingDir?: string; threadContext?: ThreadContext; contextSuffix?: string };
  sharedContext?: Record<string, unknown>;
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
    /** What a wake on a connection adds to a run. */
    private wake?: WakeDeps,
  ) {}

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
          channelThreadKey: callerKey(req.key.caller),
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

        const thread = req.init?.threadContext;
        const caller = req.key.caller;
        const callerId = callerKey(caller);
        // The conversation the turn is kept in where it replies.
        const romeSessionId =
          callerChatId(caller) ??
          thread?.romeSessionId ??
          (thread ? channelChatId(thread.channel, thread.threadId) : undefined);
        const surface = sessionSurfaceOf(this.wake?.surface ?? {}, caller, thread, {
          ...(req.init?.contextSuffix ? { about: req.init.contextSuffix } : {}),
        });
        const acquireStartedAt = Date.now();
        log.info("agent.session.manager.acquire started", baseLogFields);

        let session: AgentSession;
        try {
          if (req.sessionId) {
            const model = await rememberedChatModel(
              { webchatRepo: this.webchatRepo, sessions: this.manager },
              {
                agentName: req.key.agentName,
                sessionId: req.sessionId,
                caller,
                replies: thread,
              },
            );
            session = await this.manager.session(req.sessionId, req.key.agentName, surface, {
              workingDir,
              ...(model ? { model } : {}),
            });
          } else {
            // A wake by a message on a connection applies the place's reset setting.
            if (req.platformMessageId) {
              await resetWhenDue(
                this.manager,
                this.wake?.resolveReset,
                req.key.agentName,
                caller,
                thread,
              );
            }
            session = await openNamed(callerId, callerChatId(caller), () =>
              this.manager.open(req.key.agentName, callerId, surface, { workingDir }),
            );
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

        // The line the run names by its platform id, which the turn answers,
        // and the one its reply quotes, as Chats holds them.
        const lines =
          this.runLineDeps && thread?.romeSessionId
            ? await runLines(this.runLineDeps.lines, thread.romeSessionId, req)
            : null;

        // sendTurn is sync — turnId returned immediately,
        // events drain in the background as the turn runs.
        const briefing = catchUpBriefing(this.wake?.catchUp ?? {}, {
          threadContext: thread,
          replyTo: req.replyTo,
          quoted: lines?.quoted ?? null,
        });
        // The worker's action is the execution the turn runs under.
        const handle = withTurnExecution(req.actionContext, () =>
          session.sendTurn(
            { ...req.input, ...(req.sharedContext ? { sharedContext: req.sharedContext } : {}) },
            briefing ? { briefing } : undefined,
          ),
        );
        const turnLogFields = {
          ...baseLogFields,
          sessionId: session.sessionId,
          turnId: handle.turnId,
        };
        const workerWatch = interruptTurnOnWorkerDisconnect(rpc, session, handle, turnLogFields);
        try {
          this.runLineDeps?.replies?.runs(handle.turnId, req.key.agentName);
          if (romeSessionId) {
            await linkPromptToTurn(
              { webchatRepo: this.webchatRepo, runLineDeps: this.runLineDeps },
              {
                romeSessionId,
                turnId: handle.turnId,
                lines,
                platformMessageId: req.platformMessageId,
              },
            );
          }
        } catch (err) {
          // The drain loop below never starts, so nothing would read this
          // turn's events and the worker never learns its turnId.
          workerWatch.interrupt("agent turn setup failed");
          throw err;
        }

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
              if (!liveStream && msg.type === "turn_start" && this.turnStreams) {
                try {
                  liveStream = this.turnStreams.register({
                    sessionId: msg.sessionId,
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

        return { turnId: handle.turnId, sessionId: session.sessionId };
      });
    });

    rpc.handle<{ key: RunTurnKey; reason?: string }, { ok: true }>(
      "agent.session.interrupt",
      async (req) => {
        const sess = this.manager.live(req.key.agentName, callerKey(req.key.caller));
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
