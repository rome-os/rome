// Detached child agent sessions: the main-process implementation of the
// `ChildSessions` surface an action sees. A detached child runs the same
// subagent machinery as a blocking one (type `subagent`, parent ids, a durable
// trace) minus the two things that tie a child to the turn that started it —
// the active-subagent registry entry and the parent's `AgentSessionImpl`
// childManager, which dies with the parent session. Contract:
// docs/concepts/sessions.md#detached-subagent-sessions.
//
// Ownership is by agent, not by session. The consumer is a manager agent on a
// schedule, which gets a fresh session every run: the run that reads a child is
// never the run that started it. So a caller may read, resume, or stop a child
// exactly when the child's parent session belongs to the same agent the caller
// does, and every other caller reads the child as absent.
//
// A detached child does not survive a restart (see
// docs/adrs/child-session-owns-subagent-stream-and-cost.md), so status joins
// the durable trace with the live turn-stream registry rather than trusting
// either alone: a turn that opened and never closed, with no live stream
// behind it, is `interrupted`.

import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type {
  ChildSessionCaller,
  ChildSessions,
  ChildSessionStatus,
  ChildSessionStatusReport,
  ChildSessionStopResult,
  DetachedChildParent,
  DetachedChildStarted,
  StartDetachedChildInput,
} from "@rome-os/app-runtime";
import { getCurrentActionContext, MAX_CHILD_TRANSCRIPT_TAIL } from "@rome-os/app-runtime";
import { isCoreMainAgentId } from "../apps/artifact-id.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { createLogger } from "../logger.js";
import type { AgentSessionManager } from "./agent-session.js";
import type {
  ActiveAgentTurnStream,
  AgentTurnStreamRegistry,
} from "./agent-turn-stream-registry.js";
import type { SubagentExecutionService } from "./subagent-execution.js";

const log = createLogger("detached-subagent");

/** Live detached children one parent session may hold at once. A manager bot
 * fans out a handful of jobs per routine tick; past this the parent is looping,
 * and every extra child is a full agent session's worth of memory and tokens. */
export const MAX_LIVE_DETACHED_CHILDREN_PER_PARENT = 8;

/** Live detached children this process may hold at once, across every parent.
 * The per-parent cap alone bounds nothing over time: a manager agent on a
 * schedule gets a fresh session each run, so each run starts with an empty
 * per-parent budget while the previous run's children are still going. */
export const MAX_LIVE_DETACHED_CHILDREN = 32;

/** How long shutdown waits for detached children to close after they have been
 * interrupted, before leaving them behind so the process can exit. */
export const DETACHED_SHUTDOWN_GRACE_MS = 10_000;

export interface DetachedSubagentServiceDeps {
  webchatRepo: WebChatRepository;
  subagents: SubagentExecutionService;
  turnStreams: AgentTurnStreamRegistry;
  /** Session manager the child runs under. Lives as long as the process, so a
   * child outlives the parent session that started it. */
  detachedManager: AgentSessionManager;
  resolveDefaultWorkingDir: () => Promise<string>;
}

export interface DetachedSubagentService extends ChildSessions {
  /** Stops every live child and closes the manager they run under. Bounded:
   * returns after {@link DETACHED_SHUTDOWN_GRACE_MS} even when a child has not
   * closed, so a wedged provider cannot hold the process open. */
  shutdown(): Promise<void>;
}

export function createDetachedSubagentService(
  deps: DetachedSubagentServiceDeps,
): DetachedSubagentService {
  // parentSessionId -> child session ids this process started for it. An entry
  // is dropped as soon as its child's completion settles; the sweep before each
  // cap decision is the backstop for a completion that never settles, so the
  // map cannot grow across a long-lived process.
  const childrenByParent = new Map<string, Set<string>>();

  const isLive = (sessionId: string): boolean =>
    deps.turnStreams.listBySession(sessionId).length > 0;

  const forget = (parentSessionId: string, childSessionId: string): void => {
    const children = childrenByParent.get(parentSessionId);
    if (!children) return;
    children.delete(childSessionId);
    if (children.size === 0) childrenByParent.delete(parentSessionId);
  };

  /** Drops every tracked child with no live turn behind it, then reports what
   * is left in total and per parent. */
  const sweepLiveChildren = (): { total: number; byParent: Map<string, number> } => {
    let total = 0;
    const byParent = new Map<string, number>();
    for (const [parentSessionId, children] of [...childrenByParent]) {
      for (const sessionId of [...children]) {
        if (!isLive(sessionId)) children.delete(sessionId);
      }
      if (children.size === 0) {
        childrenByParent.delete(parentSessionId);
        continue;
      }
      byParent.set(parentSessionId, children.size);
      total += children.size;
    }
    return { total, byParent };
  };

  /** Canonical name of the agent a session belongs to. The main agent has no
   * stored name of its own, so a null column and every spelling of the core
   * main agent id read as one agent. */
  const agentIdentity = (agentName: string | null | undefined): string =>
    !agentName || isCoreMainAgentId(agentName) ? "main" : agentName;

  const callerIdentity = async (caller: ChildSessionCaller): Promise<string> => {
    const row = await deps.webchatRepo.getSession(caller.romeSessionId);
    // The stored row is the authority when there is one. A caller can outrun
    // its own row: the trace recorder writes it as the turn's first blocks
    // land, and the turn can call an action before that.
    return agentIdentity(row ? row.agentName : caller.agentName);
  };

  /** The child session `sessionId` names, when the caller's agent owns it.
   * Null in every other case — no such session, not a child session, or
   * another agent's child — because a caller must not be able to tell those
   * apart. */
  const ownedChild = async (sessionId: string, caller: ChildSessionCaller) => {
    const session = await deps.webchatRepo.getSession(sessionId);
    if (!session || session.type !== "subagent" || !session.parentSessionId) return null;
    const lineageParent = await deps.webchatRepo.getSession(session.parentSessionId);
    if (!lineageParent) return null;
    if (agentIdentity(lineageParent.agentName) !== (await callerIdentity(caller))) return null;
    return session;
  };

  const readStatus = async (
    sessionId: string,
  ): Promise<{
    status: ChildSessionStatus;
    turnId: string | null;
    outcome: Awaited<ReturnType<WebChatRepository["getLatestTurnOutcome"]>>;
    live: ActiveAgentTurnStream | undefined;
  }> => {
    const liveStreams = deps.turnStreams.listBySession(sessionId);
    const outcome = await deps.webchatRepo.getLatestTurnOutcome(sessionId);
    const live = liveStreams[liveStreams.length - 1];
    if (live) return { status: "running", turnId: live.turnId, outcome, live };
    if (!outcome) return { status: "unknown", turnId: null, outcome, live: undefined };
    return {
      status: mapTurnEndStatus(outcome.turnEndStatus),
      turnId: outcome.turnId,
      outcome,
      live: undefined,
    };
  };

  return {
    async startDetached(input: StartDetachedChildInput): Promise<DetachedChildStarted> {
      const { parentSessionId, parentTurnId, parentAgentName } = resolveParent(input.parent);
      const caller: ChildSessionCaller = {
        romeSessionId: parentSessionId,
        agentName: parentAgentName,
      };
      if (input.workingDir !== undefined && !path.isAbsolute(input.workingDir)) {
        throw new Error(`workingDir must be an absolute path, got "${input.workingDir}"`);
      }

      const callerSession = await deps.webchatRepo.getSession(parentSessionId);
      // Only a session that is not itself a child may fan children out. Every
      // child session carries type `subagent`, detached or not, so this one
      // test also stops a detached child from starting detached children of its
      // own — a tree no caller can account for and no per-parent cap can bound.
      if (callerSession?.type === "subagent") {
        throw new Error("a child agent session cannot start detached children of its own");
      }

      let lineageParentSessionId = parentSessionId;
      let childProjectPath = input.workingDir;
      let workingDir = input.workingDir;

      if (input.resumeSessionId) {
        // Ownership before liveness: a caller that does not own this child must
        // not learn from the error whether it exists or is running.
        const child = await ownedChild(input.resumeSessionId, caller);
        if (!child?.parentSessionId) {
          throw new Error(
            `no detached child session "${input.resumeSessionId}" belongs to this agent`,
          );
        }
        if (isLive(input.resumeSessionId)) {
          throw new Error("child is still running");
        }
        const childDir = child.projectPath;
        if (workingDir && childDir && workingDir !== childDir) {
          throw new Error(
            `child session "${input.resumeSessionId}" works in "${childDir}"; a resume cannot move it to "${workingDir}"`,
          );
        }
        // `startSubagent` insists a resumed child is handed the parent it is
        // already filed under, and re-parenting would cut the child out of the
        // lineage the first run recorded. Ownership is by agent and has just
        // been checked, so hand back the child's own parent rather than this
        // caller's session.
        lineageParentSessionId = child.parentSessionId;
        workingDir = workingDir ?? childDir ?? undefined;
        childProjectPath = undefined;
      }

      const { total, byParent } = sweepLiveChildren();
      const live = byParent.get(parentSessionId) ?? 0;
      if (live >= MAX_LIVE_DETACHED_CHILDREN_PER_PARENT) {
        throw new Error(
          `this session already has ${live} detached children running (limit ${MAX_LIVE_DETACHED_CHILDREN_PER_PARENT}); wait for one to finish`,
        );
      }
      if (total >= MAX_LIVE_DETACHED_CHILDREN) {
        throw new Error(
          `Rome already has ${total} detached children running (limit ${MAX_LIVE_DETACHED_CHILDREN}); wait for one to finish`,
        );
      }

      const resolvedWorkingDir =
        workingDir ?? callerSession?.projectPath ?? (await deps.resolveDefaultWorkingDir());

      const execution = await deps.subagents.startSubagent(
        input.agentName,
        { prompt: input.prompt, resumeSessionId: input.resumeSessionId },
        {
          parentSessionId: lineageParentSessionId,
          parentAgentSessionId: parentSessionId,
          parentTurnId,
          // No parent tool call owns a detached child, so this id only has to
          // be unique — nothing ever looks the child up by it.
          parentToolUseId: `detached:${uuidv4()}`,
          parentAgentName,
          parentChannelThreadKey: `detached:${lineageParentSessionId}`,
          childManager: deps.detachedManager,
          workingDir: resolvedWorkingDir,
          ...(childProjectPath ? { childProjectPath } : {}),
          detached: true,
        },
      );

      const children = childrenByParent.get(parentSessionId) ?? new Set<string>();
      children.add(execution.sessionId);
      childrenByParent.set(parentSessionId, children);

      // Nothing awaits a detached child, so its outcome would otherwise be
      // observable only by polling. Log it once so an operator reading the
      // daemon log sees the same terminal state `getStatus` will report, and
      // free the child's slot in the same place.
      void execution.completion.then(
        (completion) => {
          forget(parentSessionId, execution.sessionId);
          log.info("detached child finished", {
            sessionId: execution.sessionId,
            turnId: execution.turnId,
            agentName: execution.agentName,
            parentSessionId: lineageParentSessionId,
            status: completion.status,
          });
        },
        (err: unknown) => {
          forget(parentSessionId, execution.sessionId);
          log.warn("detached child completion rejected", {
            sessionId: execution.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );

      return {
        sessionId: execution.sessionId,
        turnId: execution.turnId,
        agentName: execution.agentName,
        parentSessionId: lineageParentSessionId,
      };
    },

    async getStatus({
      sessionId,
      transcriptTail,
      caller,
    }): Promise<ChildSessionStatusReport | null> {
      const session = await ownedChild(sessionId, resolveCaller(caller));
      if (!session) return null;

      const { status, turnId, outcome } = await readStatus(sessionId);
      const reportsOutcome = status !== "running" && outcome !== null;
      const tail = Math.min(Math.max(transcriptTail ?? 0, 0), MAX_CHILD_TRANSCRIPT_TAIL);
      const transcript =
        tail > 0 ? await deps.webchatRepo.getRecentTranscript(sessionId, tail) : [];

      return {
        sessionId,
        agentName: session.agentName ?? null,
        parentSessionId: session.parentSessionId ?? null,
        status,
        turnId,
        startedAt: session.createdAt.toISOString(),
        updatedAt: session.activityAt.toISOString(),
        reply: reportsOutcome ? outcome.reply : null,
        error: reportsOutcome ? outcome.error : null,
        ...(tail > 0
          ? {
              transcript: transcript.map((row) => ({
                role: row.role === "user" ? ("user" as const) : ("assistant" as const),
                turnId: row.turnId,
                text: row.text,
                createdAt: row.createdAt.toISOString(),
              })),
            }
          : {}),
      };
    },

    async stop({ sessionId, caller }): Promise<ChildSessionStopResult | null> {
      const session = await ownedChild(sessionId, resolveCaller(caller));
      if (!session) return null;

      const { status, live } = await readStatus(sessionId);
      if (!live?.interrupt) return { stopped: false, status };
      await live.interrupt("stopped by the summoning agent");
      log.info("detached child stopped", { sessionId, turnId: live.turnId });
      return { stopped: true, status };
    },

    async shutdown(): Promise<void> {
      // Interrupt before closing: closing a manager awaits each session's close,
      // and a session mid-turn waits on the provider, which can take as long as
      // the provider likes. The deadline below is the backstop, not the plan.
      const liveStreams = [...childrenByParent.values()]
        .flatMap((children) => [...children])
        .flatMap((sessionId) => deps.turnStreams.listBySession(sessionId));
      await Promise.all(
        liveStreams.map(async (stream) => {
          try {
            await stream.interrupt?.("shutdown");
          } catch {
            // A child that refuses to be interrupted still must not stop the
            // rest from being asked.
          }
        }),
      );
      childrenByParent.clear();
      await withDeadline(deps.detachedManager.shutdown(), DETACHED_SHUTDOWN_GRACE_MS, () => {
        log.warn("detached child sessions did not close in time; leaving them behind", {
          graceMs: DETACHED_SHUTDOWN_GRACE_MS,
        });
      });
    },
  };
}

/** A turn that closed reports the bracket it closed with. A turn with no
 * closing bracket and no live stream behind it was cut short — the process
 * exited mid-turn, and a detached child is not resumed after a restart. */
function mapTurnEndStatus(turnEndStatus: string | null): ChildSessionStatus {
  switch (turnEndStatus) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    default:
      return "interrupted";
  }
}

/** The parent ids the child is filed under: taken from the caller when the
 * runtime seam supplied them (the worker proxy reads them before the RPC hop
 * leaves the action context), else from the ambient action context. */
function resolveParent(supplied: DetachedChildParent | undefined): DetachedChildParent {
  if (supplied) return supplied;
  const ctx = getCurrentActionContext();
  if (!ctx?.romeSessionId || !ctx.turnId) {
    throw new Error(
      "a detached child needs an agent-session caller: this action was not invoked from an agent turn",
    );
  }
  return {
    parentSessionId: ctx.romeSessionId,
    parentTurnId: ctx.turnId,
    parentAgentName: ctx.agentName ?? "main",
  };
}

/** Who is asking, on the same terms as {@link resolveParent}: the stamped
 * caller when the runtime seam supplied one, else the ambient action context. */
function resolveCaller(supplied: ChildSessionCaller | undefined): ChildSessionCaller {
  if (supplied) return supplied;
  const ctx = getCurrentActionContext();
  if (!ctx?.romeSessionId) {
    throw new Error(
      "reading a detached child needs an agent-session caller: a child answers only to the agent that owns it, and this action was not invoked from an agent turn",
    );
  }
  return { romeSessionId: ctx.romeSessionId, agentName: ctx.agentName ?? "main" };
}

/** Settles when `work` settles or `ms` elapses, whichever is first, calling
 * `onTimeout` in the latter case. A rejection of `work` is swallowed. The timer
 * is unref'd, so a pending deadline never keeps the process alive. */
async function withDeadline(
  work: Promise<unknown>,
  ms: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve();
    }, ms);
    timer.unref?.();
  });
  await Promise.race([work.then(noop, noop), deadline]);
  if (timer) clearTimeout(timer);
}

function noop(): void {}
