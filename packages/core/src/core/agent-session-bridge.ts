// Main-process AgentSession bridge. Session model: docs/concepts/sessions.md.
// Exposes AgentSessionManager to forked
// workers over IpcRpc. Workers call `agent.session.runTurn` and consume the
// returned `agent.turn:<turnId>` stream.

import type { ChildProcess } from "node:child_process";
import { IpcRpc, createChildProcessTransport } from "../actions/ipc.js";
import type {
  ConversationId,
  CurrentActionContext,
  MessageReplyReference,
  RomeSessionRef,
  StreamAgentMessage,
} from "@rome-os/app-runtime";
import type {
  AgentSessionInit,
  AgentSessionKey,
  AgentSessionManager,
  AgentSession,
  AgentTurnInput,
} from "./agent-session.js";
import { createLogger } from "../logger.js";
import { runWithHookInvocationContext, type HookInvocationContext } from "./hook-recursion.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import {
  AgentTraceRecorder,
  recordAgentTraceBestEffort,
  resolveRomeSessionId,
  resolveRomeSessionType,
  shouldPersistAgentTrace,
} from "./agent-trace-recorder.js";
import {
  type ActionWorkerCoordinator,
  registerActionSubprocessHost,
} from "../actions/action-subprocess.js";
import { actionExecutionContext } from "../actions/context.js";
import { replayContext } from "../actions/replay.js";
import type { AgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";

const log = createLogger("agent-session-bridge");

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
  attach(child: ChildProcess): IpcRpc;
}

/**
 * Bridge wires `AgentSessionManager` into a worker child's IPC channel.
 * Constructed once in main; call `attach(child)` for each forked worker.
 *
 * The bridge installs an IpcRpc on the child and registers
 * `agent.session.runTurn`. The handler resolves to
 * `{ turnId, sessionId, romeSession }`, and the worker subscribes to the named
 * stream `agent.turn:<turnId>` to receive AgentMessages.
 */
export class AgentSessionBridge implements AgentSessionChildBridge {
  constructor(
    private manager: AgentSessionManager,
    private webchatRepo?: WebChatRepository,
    private actionWorkerCoordinator?: ActionWorkerCoordinator,
    private turnStreams?: AgentTurnStreamRegistry,
  ) {}

  attach(child: ChildProcess): IpcRpc {
    const transport = createChildProcessTransport(child);
    const rpc = new IpcRpc(transport, "main", {
      runInbound: async (callback) =>
        await replayContext.exit(() => actionExecutionContext.exit(callback)),
    });

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

        // Every run over this bridge is a forked action worker asking main to
        // run an agent — a nested subagent run (e.g. blocking `summon`) by
        // construction. Mark it so `rome.session.acquire` labels these opens
        // `is_subagent=true`; the top-level manager itself is `isSubagent=false`.
        const init = {
          ...req.init,
          isSubagent: true,
          platformMessageId: req.platformMessageId,
        };
        const acquireStartedAt = Date.now();
        log.info("agent.session.manager.acquire started", baseLogFields);

        let session: AgentSession;
        try {
          session = req.sessionId
            ? await this.acquireExplicitSession(req.sessionId, req.key.agentName, init)
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

        const boundRomeSessionId = session.romeSessionId ?? req.init?.romeSessionId;
        const romeSessionId = resolveRomeSessionId({
          agentName: req.key.agentName,
          agentSessionId: session.sessionId,
          romeSessionId: boundRomeSessionId,
          channelThreadKey: req.key.channelThreadKey,
          threadContext: req.init?.threadContext,
          actionContext: req.actionContext,
        });
        const romeSessionType = resolveRomeSessionType({
          threadContext: req.init?.threadContext,
        });
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
        if (this.webchatRepo && boundRomeSessionId && req.platformMessageId) {
          await this.webchatRepo.assignConversationMessageTurn(
            romeSessionId,
            req.platformMessageId,
            handle.turnId,
          );
        }

        const recorder =
          this.webchatRepo && shouldPersistAgentTrace(req.init?.threadContext)
            ? new AgentTraceRecorder({
                webchatRepo: this.webchatRepo,
                agentName: req.key.agentName,
                agentSessionId: session.sessionId,
                romeSessionId,
                existingSessionId: boundRomeSessionId ? romeSessionId : undefined,
                channelThreadKey: req.key.channelThreadKey,
                turnId: handle.turnId,
                threadContext: req.init?.threadContext,
                actionContext: req.actionContext,
                persistTranscript: true,
                persistUserTranscript: !boundRomeSessionId,
              })
            : null;

        log.info("agent.session.runTurn response ready", {
          ...baseLogFields,
          sessionId: session.sessionId,
          turnId: handle.turnId,
          durationMs: Date.now() - requestStartedAt,
        });

        const stream = ctx.openStream<StreamAgentMessage>(`agent.turn:${handle.turnId}`);
        // Drain the per-turn events into the IPC stream.
        void (async () => {
          let liveStream: ReturnType<AgentTurnStreamRegistry["register"]> | null = null;
          try {
            for await (const msg of handle.events) {
              if (!liveStream && msg.type === "turn_start" && this.turnStreams) {
                const thread = req.init?.threadContext;
                try {
                  liveStream = this.turnStreams.register({
                    sessionId: msg.sessionId,
                    turnId: msg.turnId,
                    agentName: session.key.agentName,
                    ...(thread?.connectionId
                      ? {
                          conversation: {
                            connectionId: thread.connectionId,
                            conversationId: thread.threadId as ConversationId,
                          },
                        }
                      : {}),
                    ...(thread?.channelUserId ? { initiatorId: thread.channelUserId } : {}),
                    interrupt: handle.interrupt,
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

    return rpc;
  }

  private async acquireExplicitSession(
    sessionId: string,
    agentName: string,
    init?: AgentSessionInit,
  ) {
    if (!this.manager.acquireBySessionId) {
      throw new Error("AgentSessionManager cannot resume by explicit session id");
    }
    return await this.manager.acquireBySessionId(sessionId, agentName, init);
  }
}
