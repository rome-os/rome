// The subagent call service's ports over today's run, live turns and turn log.
// They go once the session and the turn log move into the agent context.

import {
  storeSubagentParent,
  type LiveTurns,
  type SessionPlace,
  type SubagentSession,
  type SubagentSessions,
  type SubagentTurnLog,
} from "../agent/index.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { createLogger } from "../logger.js";
import type { AgentSession, AgentSessionManager } from "./agent-session.js";
import { AgentTraceRecorder, recordAgentTraceBestEffort } from "./agent-trace-recorder.js";
import type { AgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import { openedInChat } from "./session-conversation.js";

const log = createLogger("subagent-execution");

function subagentSession(child: AgentSession): SubagentSession {
  return {
    id: child.sessionId,
    submit(prompt, parentTurn, context) {
      const { turnId, events } = child.sendTurn(
        { prompt },
        {
          lifecycleParent: parentTurn,
          threadContext: context.threadContext,
          sharedContext: context.sharedContext,
          romeSessionId: child.sessionId,
          romeSessionType: "subagent",
          initiatedBy: "system",
        },
      );
      return { turnId, events };
    },
    stop: (reason) => child.interrupt(reason),
  };
}

const opening = (at: SessionPlace) => ({
  workingDir: at.workingDir,
  threadContext: at.threadContext,
  sharedContext: at.sharedContext,
});

/** A calling session's subagent sessions, opened by its session manager under
 *  its stored parent link. */
export function subagentSessions(
  manager: AgentSessionManager,
  parentLink: string,
  webchatRepo: Pick<WebChatRepository, "recordSessionInChat">,
): SubagentSessions {
  return {
    async open(subagent, at) {
      const child = await manager.acquire(
        { agentName: subagent, channelThreadKey: storeSubagentParent(parentLink) },
        opening(at),
      );
      await openedInChat(webchatRepo, child, undefined);
      return subagentSession(child);
    },
    async resume(id, subagent, at) {
      const child = await manager.acquireBySessionId(id, subagent, opening(at));
      // Naming the chat lets the resume fill a row whose record failed when
      // the subagent was minted.
      await openedInChat(webchatRepo, child, id);
      return subagentSession(child);
    },
  };
}

/** A subagent's turns in the live turns registry, recorded in its own chat. */
export function subagentLiveTurns(turnStreams: AgentTurnStreamRegistry): LiveTurns {
  return {
    register(turn) {
      const stream = turnStreams.register({
        sessionId: turn.sessionId,
        // The subagent's chat is minted under its own session id.
        chatId: turn.sessionId,
        turnId: turn.turnId,
        agentName: turn.agentName,
        interrupt: turn.stop,
      });
      return { publish: (event) => stream.publish(event), finish: () => stream.finish() };
    },
  };
}

/** A subagent's turn log, in its trace. */
export function subagentTurnLog(webchatRepo: WebChatRepository): SubagentTurnLog {
  return {
    open(turn) {
      const recorder = new AgentTraceRecorder({
        webchatRepo,
        agentName: turn.agentName,
        turnId: turn.turnId,
        existingSessionId: turn.sessionId,
        threadContext: turn.threadContext,
        persistTranscript: true,
      });
      return {
        record: (event) =>
          recordAgentTraceBestEffort(recorder, event, log, {
            turnId: turn.turnId,
            source: "subagent-execution",
          }),
      };
    },
  };
}
