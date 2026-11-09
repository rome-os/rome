// The subagent call service's ports over the run's session manager, the live
// turns and the turn log. They go once the session takes `submit` and `stop`
// and the turn log moves into the agent context.

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
import type { AgentSession, SessionOpening, Sessions } from "../agent/index.js";
import { AgentTraceRecorder, recordAgentTraceBestEffort } from "./agent-trace-recorder.js";
import type { AgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import { openedInChat } from "./session-conversation.js";

const log = createLogger("subagent-execution");

function subagentSession(child: AgentSession): SubagentSession {
  return {
    id: child.sessionId,
    submit(prompt, parentTurn, context) {
      const { turnId, turn } = child.submit(
        { prompt },
        {
          priority: "after",
          lifecycleParent: parentTurn,
          threadContext: context.threadContext,
          sharedContext: context.sharedContext,
          romeSessionId: child.sessionId,
          romeSessionType: "subagent",
          initiatedBy: "system",
        },
      );
      return {
        turnId,
        events: (async function* () {
          yield* (await turn).events();
        })(),
      };
    },
    stop: (reason) => child.stop(reason),
  };
}

/** What a parent hands its subagent's sessions: its tools' environment and its span attributes. */
type Inherited = Pick<SessionOpening, "toolEnv" | "spanAttributes">;

/** A subagent's session shows no cards and takes no wake-ups; its tools and spans carry its parent's. */
const opening = (at: SessionPlace, inherited: Inherited): SessionOpening => ({
  workingDir: at.workingDir,
  threadContext: at.threadContext,
  sharedContext: at.sharedContext,
  drawsCards: false,
  guardianFacing: false,
  ...inherited,
});

/** A calling session's subagent sessions, opened by its session manager under
 *  its stored parent link. */
export function subagentSessions(
  manager: Sessions,
  parentLink: string,
  webchatRepo: Pick<WebChatRepository, "recordSessionInChat">,
  inherited: Inherited = {},
): SubagentSessions {
  return {
    async open(subagent, at) {
      const child = await manager.open(
        { agentName: subagent, channelThreadKey: storeSubagentParent(parentLink) },
        opening(at, inherited),
      );
      await openedInChat(webchatRepo, child, undefined);
      return subagentSession(child);
    },
    async resume(id, subagent, at) {
      const child = await manager.resume({ id, agent: subagent }, opening(at, inherited));
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
      return turnStreams.register({
        sessionId: turn.sessionId,
        // The subagent's chat is minted under its own session id.
        chatId: turn.sessionId,
        turnId: turn.turnId,
      });
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
