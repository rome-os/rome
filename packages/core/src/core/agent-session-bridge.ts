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
  ReplyDeliveryReport,
  RomeSessionRef,
  StreamAgentEvent,
} from "@rome-os/app-runtime";
import type { ReplyOutcome } from "../channels/delivery/reply.js";
import type { ReplyStream, ReplyStreams } from "../channels/delivery/streams.js";
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
  /** Deliver the reply into the thread as it is written, when reply streaming
   *  is on and the channel can. See `RunParams.streamReply`. */
  streamReply?: boolean;
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
    /** Streams replies into external channels while reply streaming is on. */
    private replyStreams?: ReplyStreams,
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
          sessionConversation: session.conversation,
          channelThreadKey: req.key.channelThreadKey,
          threadContext: req.init?.threadContext,
          actionContext: req.actionContext,
        });
        const { romeSessionId, romeSessionType } = conversation;
        const romeSession: RomeSessionRef = {
          _romeSessionId: romeSessionId,
          _type: romeSessionType,
        };

        // sendTurn is sync — turnId returned immediately,
        // events drain in the background as the turn runs.
        const handle = session.sendTurn(req.input, {
          threadContext: req.init?.threadContext,
          sharedContext: req.init?.sharedContext,
          romeSessionId,
          romeSessionType,
          replyTo: req.replyTo,
        });
        const turnLogFields = {
          ...baseLogFields,
          sessionId: session.sessionId,
          turnId: handle.turnId,
        };
        let reply: ReplyStream | null = null;
        let replyStopped = false;
        const workerWatch = interruptTurnOnWorkerDisconnect(
          rpc,
          session,
          handle,
          turnLogFields,
          () => {
            replyStopped = true;
            reply?.stop();
          },
        );
        if (this.webchatRepo && conversation.promptPersisted && req.platformMessageId) {
          try {
            await this.webchatRepo.assignConversationMessageTurn(
              romeSessionId,
              req.platformMessageId,
              handle.turnId,
            );
          } catch (err) {
            // The drain loop below never starts, so nothing would read this
            // turn's events and the worker never learns its turnId.
            workerWatch.interrupt("agent turn setup failed");
            throw err;
          }
        }

        // A reply streams only when the caller asked, the setting is on and the
        // channel can. Otherwise `reply` is null and the caller sends the reply.
        // A reply that cannot open is the same: it must not fail the turn it
        // would ride on, whose events nothing would then read.
        const thread = req.init?.threadContext;
        if (req.streamReply && thread?.channel && thread.threadId) {
          try {
            const opened = await this.replyStreams?.open({
              channel: thread.channel,
              chatId: thread.threadId,
              ...(req.platformMessageId ? { replyToMessageId: req.platformMessageId } : {}),
              // The transcript leaves the answer to the reply, so the reply
              // records it in the conversation the turn is recorded in.
              romeSessionId,
              turnId: handle.turnId,
            });
            // The worker may have gone away while the reply opened. Nobody is
            // left to stream to, so the reply is dropped before it writes.
            if (opened && replyStopped) opened.stop();
            else reply = opened ?? null;
          } catch (err) {
            log.warn("reply stream could not open, the caller sends the reply", {
              ...turnLogFields,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

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
                persistAssistantTranscript: !reply,
              })
            : null;

        log.info("agent.session.runTurn response ready", {
          ...baseLogFields,
          sessionId: session.sessionId,
          turnId: handle.turnId,
          durationMs: Date.now() - requestStartedAt,
        });

        let replySettled = false;
        // A fault in the reply stream must never break the turn it rides on.
        let replyBroken = false;
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
                    // Stop closes the reply before the provider, so nothing new
                    // is written while the turn winds down.
                    interrupt:
                      reply && interrupt
                        ? (reason) => {
                            reply.stop();
                            return interrupt(reason);
                          }
                        : interrupt,
                  });
                } catch (err) {
                  log.warn("failed to register agent turn stream", {
                    turnId: handle.turnId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
              liveStream?.publish(msg);
              if (recorder) {
                await recordAgentTraceBestEffort(recorder, msg, log, {
                  turnId: handle.turnId,
                  source: "agent-session-bridge",
                });
              }
              if (reply && !replyBroken) {
                try {
                  reply.accept(msg);
                } catch (err) {
                  replyBroken = true;
                  log.warn("reply stream failed, the run continues", {
                    turnId: handle.turnId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                  reply.stop();
                }
              }
              if (reply && msg.type === "turn_end") {
                // The caller learns the reply's fate on the turn's last event,
                // so it never sends a reply the platform already shows. The
                // turn stays registered until then, so a Stop meanwhile stops
                // the reply.
                replySettled = true;
                const replyDelivery = await settleReply(
                  reply,
                  replyBroken || msg.status === "interrupted",
                  replyBroken,
                  turnLogFields,
                );
                stream.send({ ...msg, replyDelivery });
                continue;
              }
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
            // A turn that ended without turn_end leaves no caller to report to:
            // stop writing rather than finish a reply nobody settles.
            if (reply && !replySettled) void settleReply(reply, true, replyBroken, turnLogFields);
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
 * runs a late subscriber on the next microtask. `stopReply` runs first, so a
 * streamed reply writes nothing more, even when the run has already ended and
 * only the reply's writes remain. Never throws: an interrupt that fails is
 * logged.
 */
function interruptTurnOnWorkerDisconnect(
  rpc: IpcRpc,
  session: AgentSession,
  handle: AgentTurnHandle,
  logFields: Record<string, unknown>,
  stopReply: () => void,
): TurnWorkerWatch {
  let watching = true;
  let offDisconnect: () => void = () => undefined;
  const interrupt = (reason: string): void => {
    if (!watching) return;
    watching = false;
    offDisconnect();
    log.info("interrupting agent turn", { ...logFields, reason });
    stopReply();
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

/**
 * Settles `reply` and says what `turn_end` reports. A reply that cannot settle
 * may show anything, so it is unknown and its caller does not send it again.
 */
async function settleReply(
  reply: ReplyStream,
  stopped: boolean,
  broken: boolean,
  logFields: Record<string, unknown>,
): Promise<ReplyDeliveryReport> {
  try {
    return reportOf(await reply.settle(stopped), broken);
  } catch (err) {
    log.warn("reply stream could not settle", {
      ...logFields,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "unknown", messageIds: [] };
  }
}

/**
 * What `turn_end` reports. A reply stream that broke was stopped, which is not
 * what happened to the user: they were shown whatever it wrote before it broke.
 * Only a reply that certainly wrote nothing is safe to send again, so a create
 * whose result is unknown keeps the reply unknown.
 */
function reportOf(outcome: ReplyOutcome, broken: boolean): ReplyDeliveryReport {
  const messageIds = outcome.parts.flatMap((part) =>
    part.receipt ? [part.receipt.messageId] : [],
  );
  const status =
    !broken || outcome.status === "unknown"
      ? outcome.status
      : messageIds.length
        ? "partial"
        : "failed";
  return { status, messageIds };
}
