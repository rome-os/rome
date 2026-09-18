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
  AgentTurnHandle,
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
import { conversationPlatformMessageId } from "../db/repositories/webchat.js";
import type { ConnectionTalkRouter } from "../connections/talk-router.js";
import type { RunDelivery } from "../connections/delivery/run-delivery.js";
import type { ApprovalsRepository } from "../db/repositories/approvals.js";

const log = createLogger("agent-session-bridge");

export interface RunTurnRequest {
  admissionOnly?: boolean;
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
  admitted?: boolean;
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
    private talkRouter?: ConnectionTalkRouter,
    private approvals?: Pick<ApprovalsRepository, "create">,
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

        const attachRun = (handle: AgentTurnHandle) => {
          let recorder: AgentTraceRecorder | null = null;
          if (this.webchatRepo && shouldPersistAgentTrace(req.init?.threadContext)) {
            recorder = new AgentTraceRecorder({
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
            });
          }

          log.info("agent.session.runTurn response ready", {
            ...baseLogFields,
            sessionId: session.sessionId,
            turnId: handle.turnId,
            durationMs: Date.now() - requestStartedAt,
          });

          const stream = req.admissionOnly
            ? null
            : ctx.openStream<StreamAgentMessage>(`agent.turn:${handle.turnId}`);
          // Drain the per-turn events into the IPC stream.
          void (async () => {
            let liveStream: ReturnType<AgentTurnStreamRegistry["register"]> | null = null;
            let delivery: RunDelivery | null = null;
            let resultContent = "";
            let stopped = false;
            let deliveryInitialized = false;
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
                      interrupt: async (reason) => {
                        stopped = true;
                        const cleanup = delivery?.stop();
                        await handle.interrupt?.(reason);
                        await cleanup;
                      },
                    });
                  } catch (err) {
                    log.warn("failed to register agent turn stream", {
                      turnId: handle.turnId,
                      error: err instanceof Error ? err.message : String(err),
                    });
                  }
                }
                const thread = req.init?.threadContext;
                if (
                  !deliveryInitialized &&
                  req.admissionOnly &&
                  thread?.connectionId &&
                  this.talkRouter
                ) {
                  deliveryInitialized = true;
                  delivery = await this.talkRouter.createRunDelivery(
                    thread.connectionId,
                    handle.turnId,
                    {
                      conversationId: thread.threadId as ConversationId,
                      replyToMessageId: req.platformMessageId,
                    },
                  );
                  if (stopped) await delivery?.stop();
                }
                if (msg.type === "text_delta") delivery?.append(msg.content, msg.blockId);
                if (msg.type === "text")
                  delivery?.complete(msg.content, msg.turnPhase, msg.blockId);
                if (msg.type === "result") resultContent = msg.content;
                if (msg.type === "turn_end" && msg.status !== "completed") {
                  stopped = true;
                  await delivery?.stop();
                }
                liveStream?.publish(msg);
                if (recorder) {
                  await recordAgentTraceBestEffort(recorder, msg, log, {
                    turnId: handle.turnId,
                    source: "agent-session-bridge",
                  });
                }
                stream?.send(msg);
              }
              if (!delivery || stopped) {
                stream?.close();
                return;
              }
              const receipts = await delivery.finish(resultContent);
              if (resultContent && this.approvals) {
                await this.approvals
                  .create({
                    type: "outgoing_message",
                    requestedBy: req.key.agentName,
                    description: "Skipped envoy (guardian)",
                    status: "auto_approved",
                    payload: {
                      response: resultContent,
                      ...req.init?.threadContext,
                      turnId: handle.turnId,
                      messageId: req.platformMessageId,
                    },
                  })
                  .catch((error) =>
                    log.warn("failed to record guardian delivery audit", {
                      turnId: handle.turnId,
                      error: error instanceof Error ? error.message : String(error),
                    }),
                  );
              }
              if (resultContent && this.webchatRepo) {
                await this.webchatRepo.recordOutboundConversationMessage({
                  sessionId: romeSessionId,
                  content: JSON.stringify([{ type: "text", content: resultContent }]),
                  platformMessageId: receipts.at(-1)?.messageId,
                  replyToPlatformMessageId: req.platformMessageId,
                  turnId: handle.turnId,
                  knownToProvider: true,
                });
              }
              stream?.close();
            } catch (err) {
              log.warn("error draining agent turn into IPC stream", {
                turnId: handle.turnId,
                error: err instanceof Error ? err.message : String(err),
              });
              await delivery?.stop();
              stream?.close({ error: err instanceof Error ? err : new Error(String(err)) });
            } finally {
              liveStream?.finish();
            }
          })();
        };
        const options = {
          threadContext: req.init?.threadContext,
          sharedContext: req.init?.sharedContext,
          romeSessionId,
          romeSessionType,
          replyTo: req.replyTo,
        };
        if (req.admissionOnly) {
          const thread = req.init?.threadContext;
          if (
            !session.submitInput ||
            !this.talkRouter ||
            !this.webchatRepo ||
            !req.platformMessageId ||
            thread?.senderBondLevel !== "guardian" ||
            thread.threadType !== "private" ||
            !thread.connectionId ||
            !this.talkRouter.feature(thread.connectionId, "textDelivery")
          ) {
            return { admitted: false, turnId: "", sessionId: session.sessionId, romeSession };
          }
          const inputId = conversationPlatformMessageId(romeSessionId, req.platformMessageId);
          const receipt = session.submitInput(
            { ...req.input, inputId },
            {
              ...options,
              onTurn: attachRun,
              onInputStatus: (status) => this.webchatRepo!.updateUserInput(romeSessionId, status),
            },
          );
          return {
            admitted: true,
            turnId: receipt.turnId,
            sessionId: session.sessionId,
            romeSession,
          };
        }
        const handle = session.sendTurn(req.input, options);
        if (this.webchatRepo && boundRomeSessionId && req.platformMessageId) {
          await this.webchatRepo.assignConversationMessageTurn(
            romeSessionId,
            req.platformMessageId,
            handle.turnId,
          );
        }
        attachRun(handle);
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
