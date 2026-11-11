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
import type { WebChatRepository } from "../webchat/repository.js";
import { createLogger } from "../logger.js";
import type { AgentSession, SessionOpening, Sessions } from "../agent/index.js";
import { AgentTraceRecorder, recordAgentTraceBestEffort } from "./agent-trace-recorder.js";
import type { AgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import { openedInChat, withRomeSession } from "./session-conversation.js";

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
          initiatedBy: "system",
          // The subagent acts for the person its parent turn acts for.
          ...(context.actor ? { actor: context.actor } : {}),
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
    release: () => child.release(),
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
      await held(child, () => openedInChat(webchatRepo, child, undefined));
      return subagentSession(child);
    },
    async resume(id, subagent, at) {
      const child = await manager.resume({ id, agent: subagent }, opening(at, inherited));
      // Naming the chat lets the resume fill a row whose record failed when
      // the subagent was minted.
      await held(child, () => openedInChat(webchatRepo, child, id));
      return subagentSession(child);
    },
  };
}

/** Runs `step` on a session just acquired, letting it go when the step fails,
 *  since no turn follows (docs/concepts/sessions.md#session-in-use). */
async function held(child: AgentSession, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (err) {
    child.release();
    throw err;
  }
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
      // A subagent's turns record in the chat minted under its session's id.
      const romeSession = { _romeSessionId: turn.sessionId, _type: "subagent" as const };
      return {
        record: (event) =>
          recordAgentTraceBestEffort(recorder, withRomeSession(event, romeSession), log, {
            turnId: turn.turnId,
            source: "subagent-execution",
          }),
      };
    },
  };
}
