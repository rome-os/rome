// The run's way into subagent calls, until the run moves into the agent
// context and calls `SubagentCalls` itself.

import { subagentRequest, type SubagentCalls, type SubagentOutcome } from "../agent/index.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { AgentSessionManager } from "./agent-session.js";
import { subagentSessions } from "./subagent-call-ports.js";
import type { ThreadContext } from "./types.js";

export interface ExecuteSubagentInput {
  prompt: string;
  resumeSessionId?: string;
}

/** How a subagent call ended, with the session and turn that answered it. */
export type SubagentCompletion = SubagentOutcome & { sessionId: string; turnId: string };

export interface SubagentExecution {
  sessionId: string;
  turnId: string;
  agentName: string;
  completion: Promise<SubagentCompletion>;
  interrupt(reason?: string): Promise<void>;
}

export interface StartSubagentContext {
  /** Durable Rome session id used for persistence and parent ownership. */
  parentSessionId: string;
  /** Runtime AgentSession id used by lifecycle parent references. */
  parentAgentSessionId: string;
  parentTurnId: string;
  parentToolUseId: string;
  parentAgentName: string;
  parentChannelThreadKey: string;
  childManager: AgentSessionManager;
  workingDir: string;
  threadContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
}

export interface SubagentExecutionService {
  startSubagent(
    name: string,
    input: ExecuteSubagentInput,
    context: StartSubagentContext,
  ): Promise<SubagentExecution>;
}

export function createSubagentExecutionService(deps: {
  calls: SubagentCalls;
  webchatRepo: Pick<WebChatRepository, "recordSessionInChat">;
}): SubagentExecutionService {
  return {
    async startSubagent(name, input, context) {
      const call = await deps.calls.call(name, subagentRequest(input), {
        key: {
          dashboardSessionId: context.parentSessionId,
          turnId: context.parentTurnId,
          toolUseId: context.parentToolUseId,
        },
        agentName: context.parentAgentName,
        agentSessionId: context.parentAgentSessionId,
        sessions: subagentSessions(
          context.childManager,
          context.parentChannelThreadKey,
          deps.webchatRepo,
        ),
        at: {
          workingDir: context.workingDir,
          threadContext: context.threadContext,
          sharedContext: context.sharedContext,
        },
      });
      return {
        sessionId: call.sessionId,
        turnId: call.turnId,
        agentName: name,
        completion: call.outcome.then((outcome) => ({
          ...outcome,
          sessionId: call.sessionId,
          turnId: call.turnId,
        })),
        interrupt: (reason) => call.cancel(reason),
      };
    },
  };
}
