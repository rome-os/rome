// Main-process AgentSession bridge. Session model: docs/concepts/sessions.md.
// Exposes AgentSessionManager to forked
// workers over IpcRpc. Workers call `agent.session.runTurn` and consume the
// returned `agent.turn:<turnId>` stream.

import type { ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import type { IpcRpc } from "../actions/ipc.js";
import type {
  ConversationId,
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
import {
  getWebchatProjectsRoot,
  resolveProjectWorkingDirWithinRoot,
  resolveWorkingDirWithinRoot,
  WorkingDirOutsideRootError,
} from "../webchat/projects.js";
import { isCanonicalArtifactId } from "../apps/artifact-id.js";
import { getProfileAppDataDir } from "../paths.js";

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

export interface AgentSessionBridgeOptions {
  webchatRepo?: WebChatRepository;
  actionWorkerCoordinator?: ActionWorkerCoordinator;
  turnStreams?: AgentTurnStreamRegistry;
  /** Root that worker-requested working dirs must stay inside. Defaults to the profile's projects root. */
  projectsRoot?: string;
  /**
   * The data directory of the app that owns the named agent, or undefined for
   * a core agent or a name that does not resolve. A worker may also open that
   * agent's runs in this directory or below it. Without this option, no app
   * data directory is accepted.
   */
  appDataDirForAgent?: (agentName: string) => string | undefined;
}

/**
 * The data directory of the app that owns the agent `agentName` names, or
 * undefined when the name resolves to no loaded agent or to a core agent.
 * Never throws.
 */
export function resolveAgentAppDataDir(
  agentLoader: { getCanonicalName(name: string): string },
  agentName: string,
  appDataDir: (appId: string) => string = getProfileAppDataDir,
): string | undefined {
  try {
    const canonical = agentLoader.getCanonicalName(agentName);
    if (!isCanonicalArtifactId(canonical)) return undefined;
    const appId = canonical.slice(0, canonical.indexOf(":"));
    return appId === "core" ? undefined : appDataDir(appId);
  } catch {
    // An unknown agent fails with its own error when the manager opens the session.
    return undefined;
  }
}

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
  private readonly webchatRepo?: WebChatRepository;
  private readonly actionWorkerCoordinator?: ActionWorkerCoordinator;
  private readonly turnStreams?: AgentTurnStreamRegistry;
  private readonly projectsRoot?: string;
  private readonly appDataDirForAgent?: (agentName: string) => string | undefined;

  constructor(
    private manager: AgentSessionManager,
    options: AgentSessionBridgeOptions = {},
  ) {
    this.webchatRepo = options.webchatRepo;
    this.actionWorkerCoordinator = options.actionWorkerCoordinator;
    this.turnStreams = options.turnStreams;
    this.projectsRoot = options.projectsRoot;
    this.appDataDirForAgent = options.appDataDirForAgent;
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
        const workerWatch = interruptTurnOnWorkerDisconnect(rpc, session, handle, turnLogFields);
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
              })
            : null;

        log.info("agent.session.runTurn response ready", {
          ...baseLogFields,
          sessionId: session.sessionId,
          turnId: handle.turnId,
          durationMs: Date.now() - requestStartedAt,
        });

        const stream = ctx.openStream<StreamAgentEvent>(`agent.turn:${handle.turnId}`);
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
   * resolve inside the projects root or, for an app's agent, inside that
   * app's data directory. Without one, a new `summon` run inherits
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
      return await this.resolveRequestedWorkingDir(requested, req.key.agentName);
    }
    if (req.sessionId || req.actionContext?.actionName !== SUMMON_ACTION) return undefined;
    const callerSessionId = req.actionContext?.sessionId;
    return callerSessionId ? this.manager.findWorkingDirBySessionId(callerSessionId) : undefined;
  }

  /**
   * The app data directory is keyed by the agent's host-resolved canonical
   * id, not by the action context, because workers are pooled across apps
   * and the worker supplies the action context. A relative path names a
   * project only.
   */
  private async resolveRequestedWorkingDir(requested: string, agentName: string): Promise<string> {
    const projectsRoot = this.projectsRoot ?? getWebchatProjectsRoot();
    try {
      return await resolveProjectWorkingDirWithinRoot(requested, projectsRoot);
    } catch (err) {
      if (!(err instanceof WorkingDirOutsideRootError)) throw err;
      const appDataDir = this.appDataDirForAgent?.(agentName);
      if (!appDataDir) throw err;
      const outsideBoth = new Error(
        `Working directory "${requested}" is not inside the projects root (${projectsRoot}) ` +
          `or the app data directory of agent "${agentName}" (${appDataDir})`,
      );
      if (!isAbsolute(requested.trim())) throw outsideBoth;
      try {
        return await resolveWorkingDirWithinRoot(requested, {
          path: appDataDir,
          label: "the app data directory",
          allowRoot: true,
        });
      } catch (dataDirErr) {
        throw dataDirErr instanceof WorkingDirOutsideRootError ? outsideBoth : dataDirErr;
      }
    }
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
