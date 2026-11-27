// Builds the turn ref and timing the agent context's lifecycle calls carry,
// from Rome's thread context.

import type {
  AgentTurnRef,
  AgentTurnTiming,
  LifecycleThreadContext,
  ThreadContext,
} from "@rome-os/app-runtime";

export interface AgentTurnParentRef {
  sessionId: string;
  turnId: string;
  agentName: string;
}

export function toLifecycleThreadContext(
  context: ThreadContext | undefined,
): LifecycleThreadContext | undefined {
  if (!context) return undefined;
  return {
    channel: context.channel,
    threadId: context.threadId,
    threadPath: context.threadPath,
    channelUserId: context.channelUserId,
    threadName: context.threadName,
    threadType: context.threadType,
    projectName: context.projectName,
    projectPath: context.projectPath,
  };
}

export function createAgentTurnRef(params: {
  sessionId: string;
  turnId: string;
  agentName: string;
  channelThreadKey?: string;
  threadContext?: ThreadContext;
  parent?: AgentTurnParentRef;
}): AgentTurnRef {
  return {
    sessionId: params.sessionId,
    turnId: params.turnId,
    agentName: params.agentName,
    channelThreadKey: params.channelThreadKey,
    threadContext: toLifecycleThreadContext(params.threadContext),
    parent: params.parent,
  };
}

export function buildRequiredTiming(params: {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}): Required<AgentTurnTiming> {
  return {
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    durationMs: params.durationMs,
  };
}
