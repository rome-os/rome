// Subagent calls: answering a turn's call to a subagent with one turn of the
// subagent's session (docs/domains/agents.md#subagent-call).

import type { StreamAgentEvent, ThreadContext } from "@rome-os/app-runtime";
import type { DashboardSessions } from "../domain/dashboard-sessions.js";
import type { AgentName, SessionId } from "../domain/session.js";
import type { TurnActor } from "../domain/turn-facts.js";
import {
  newSubagentSession,
  refuseResume,
  SubagentOutcomeReader,
  type SessionRecordId,
  type SubagentOutcome,
  type SubagentRequest,
} from "../domain/subagent.js";

/** Which call: the calling session, its turn and its tool use. */
export interface SubagentCallKey {
  parentSessionId: SessionId;
  turnId: string;
  toolUseId: string;
}

/** Where and with what context a subagent's session runs. */
export interface SessionPlace {
  workingDir: string;
  threadContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
}

/** The turn a call comes from, as the run that owns it knows it. */
export interface CallingTurn {
  key: SubagentCallKey;
  /** The dashboard chat the calling turn records in, which the subagent's
   *  session is listed under. Carried with the turn while each turn picks its
   *  own chat (ZHA-157). */
  chat: SessionRecordId;
  agentName: AgentName;
  agentSessionId: SessionId;
  /** Where the caller's subagent sessions open, already bound to the calling
   *  session's stored parent link. A fork has its own, so it never resumes the
   *  source's subagent sessions. A value only while the run keeps a session
   *  manager per fork. */
  sessions: SubagentSessions;
  at: SessionPlace;
  /** Who the calling turn acts for: the subagent's turn acts for the same person. */
  actor?: TurnActor;
}

/** One subagent call, from its start to its outcome. */
export interface SubagentCall {
  subagent: AgentName;
  sessionId: SessionId;
  turnId: string;
  /** Settles once. A thrown stream fails the call with its message. */
  outcome: Promise<SubagentOutcome>;
  /** Stops the subagent's turn. Does nothing once the outcome has settled. */
  cancel(reason?: string): Promise<void>;
}

export interface SubagentCalls {
  /**
   * Starts a call and returns it running. Fails, in this order:
   * - the resume is refused: nothing is opened;
   * - opening or resuming the session, or adding a fresh one to the dashboard,
   *   fails: the session may be open with no turn;
   * - a call with the same key is already held: the subagent's turn is stopped
   *   and its live turn finished.
   */
  call(subagent: AgentName, request: SubagentRequest, from: CallingTurn): Promise<SubagentCall>;
  /** Drops the call's key; does not cancel it. True if it was still held.
   *  The parent turn's answer path calls it, and so does the webchat route for
   *  a chat's own session. */
  forget(key: SubagentCallKey): boolean;
}

/** Opening a subagent's session for one calling session. `Sessions` once the
 *  session moves into the agent context, bound to the calling session's
 *  stored parent link. */
export interface SubagentSessions {
  open(subagent: AgentName, at: SessionPlace): Promise<SubagentSession>;
  resume(id: SessionId, subagent: AgentName, at: SessionPlace): Promise<SubagentSession>;
}

/** A subagent's open session. `Session` once the session moves into the agent
 *  context. */
export interface SubagentSession {
  readonly id: SessionId;
  /** Starts one turn on behalf of the parent turn. */
  submit(
    prompt: string,
    parentTurn: { sessionId: SessionId; turnId: string; agentName: AgentName },
    context: {
      threadContext?: ThreadContext;
      sharedContext?: Record<string, unknown>;
      actor?: TurnActor;
    },
  ): { turnId: string; events: AsyncIterable<StreamAgentEvent> };
  stop(reason?: string): Promise<void>;
}

/** The subagent turn's log. Best effort: a failed write is logged. */
export interface SubagentTurnLog {
  open(turn: {
    agentName: AgentName;
    sessionId: SessionId;
    turnId: string;
    threadContext?: ThreadContext;
  }): { record(event: StreamAgentEvent): Promise<void> };
}

/** The live turns the dashboard watches, told when a subagent's turn starts and finishes. */
export interface LiveTurns {
  register(turn: { sessionId: SessionId; turnId: string }): { finish(): void };
}

const callKey = (key: SubagentCallKey): string =>
  `${key.parentSessionId}\u0000${key.turnId}\u0000${key.toolUseId}`;

export function createSubagentCalls(deps: {
  dashboard: DashboardSessions;
  turnLog: SubagentTurnLog;
  liveTurns: LiveTurns;
}): SubagentCalls {
  const held = new Set<string>();

  const openSession = async (
    subagent: AgentName,
    request: SubagentRequest,
    from: CallingTurn,
  ): Promise<SubagentSession> => {
    const parent = await deps.dashboard.get(from.chat);
    if (request.resumeSessionId) {
      const stored = parent ? await deps.dashboard.get(request.resumeSessionId) : null;
      const refusal = refuseResume(stored, parent, {
        subagent,
        parentRecordId: from.chat,
        resumeSessionId: request.resumeSessionId,
      });
      if (refusal) throw new Error(refusal);
      return await from.sessions.resume(request.resumeSessionId, subagent, from.at);
    }
    const session = await from.sessions.open(subagent, from.at);
    await deps.dashboard.addSubagentSession(
      newSubagentSession(session.id, subagent, parent, {
        chat: from.chat,
        turnId: from.key.turnId,
        agentName: from.agentName,
      }),
    );
    return session;
  };

  return {
    async call(subagent, request, from) {
      const session = await openSession(subagent, request, from);
      const turn = session.submit(
        request.prompt,
        { sessionId: from.agentSessionId, turnId: from.key.turnId, agentName: from.agentName },
        {
          threadContext: from.at.threadContext,
          sharedContext: from.at.sharedContext,
          ...(from.actor ? { actor: from.actor } : {}),
        },
      );

      let settled = false;
      const cancel = async (reason?: string): Promise<void> => {
        if (settled) return;
        await session.stop(reason);
      };
      const live = deps.liveTurns.register({ sessionId: session.id, turnId: turn.turnId });

      let settle!: (outcome: SubagentOutcome) => void;
      const outcome = new Promise<SubagentOutcome>((resolve) => {
        settle = resolve;
      });
      const call: SubagentCall = {
        subagent,
        sessionId: session.id,
        turnId: turn.turnId,
        outcome,
        cancel,
      };

      const key = callKey(from.key);
      if (held.has(key)) {
        live.finish();
        await session.stop("subagent registration failed").catch(() => undefined);
        const { parentSessionId, turnId, toolUseId } = from.key;
        throw new Error(
          `Active subagent link already exists for parent ${parentSessionId}/${turnId}/${toolUseId}`,
        );
      }
      held.add(key);

      const log = deps.turnLog.open({
        agentName: subagent,
        sessionId: session.id,
        turnId: turn.turnId,
        threadContext: from.at.threadContext,
      });
      void (async () => {
        const reader = new SubagentOutcomeReader();
        try {
          for await (const event of turn.events) {
            await log.record(event);
            reader.read(event);
          }
          settle(reader.outcome());
        } catch (err) {
          settle({
            status: "failed",
            error: { message: err instanceof Error ? err.message : String(err) },
          });
        } finally {
          settled = true;
          live.finish();
        }
      })();

      return call;
    },

    forget(key) {
      return held.delete(callKey(key));
    },
  };
}
