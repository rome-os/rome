// Test-only: the old key-string entry points over the Sessions API, so the
// manager's own tests keep their fixtures while the API changes under them.

import {
  type AgentSession,
  type AgentSessionKey,
  type AgentSessionManager,
  type SendTurnOptions,
  type TurnConversation,
  createAgentSessionManager,
  type ManagerDeps,
  type SessionOpenOptions,
} from "../core/agent-session.js";
import type { ConnectionKindOfChannel } from "../db/repositories/channel-records.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { callerFromKey, callerKey, withChatId } from "../core/session-caller.js";
import { resolveTurnConversation } from "../core/agent-trace-recorder.js";
import type { SessionConversation } from "../core/session-conversation.js";
import { sessionCallers } from "../core/session-callers.js";

export interface StoredKey {
  agentName: string;
  channelThreadKey: string;
}

export interface KeyedInit extends SessionOpenOptions {
  romeSessionId?: string;
  sharedContext?: Record<string, unknown>;
  resumeSessionId?: string;
  isSubagent?: boolean;
}

export interface TestSessionManager extends AgentSessionManager {
  acquire(key: StoredKey, init?: KeyedInit): Promise<AgentSession>;
  acquireBySessionId(id: string, agentName: string, init?: KeyedInit): Promise<AgentSession>;
  peek(key: StoredKey): AgentSession | undefined;
}

function openOptions(init: KeyedInit | undefined): SessionOpenOptions | undefined {
  if (!init) return undefined;
  const {
    romeSessionId: _romeSessionId,
    sharedContext: _sharedContext,
    resumeSessionId: _resumeSessionId,
    isSubagent: _isSubagent,
    ...options
  } = init;
  return options;
}

/** `manager` with the old key-string entry points. */
export function withKeys(manager: AgentSessionManager): TestSessionManager {
  const keyed = manager as TestSessionManager;
  keyed.acquire = (key, init) =>
    init?.resumeSessionId
      ? manager.session(init.resumeSessionId, key.agentName, openOptions(init))
      : manager.open(
          key.agentName,
          withChatId(callerFromKey(key.channelThreadKey), init?.romeSessionId),
          openOptions(init),
        );
  keyed.acquireBySessionId = (id, agentName, init) =>
    manager.session(id, agentName, openOptions(init));
  keyed.peek = (key) => manager.live(key.agentName, callerFromKey(key.channelThreadKey));
  return keyed;
}

export type LegacyManagerDeps = Omit<ManagerDeps, "callers"> & {
  callers?: ManagerDeps["callers"];
  webchatRepo?: WebChatRepository;
  connectionKindOfChannel?: ConnectionKindOfChannel;
};

/** A manager whose callers answer from `webchatRepo` and the connection kinds,
 *  as production wires them. */
export function createTestSessionManager(
  deps: LegacyManagerDeps,
  options?: Parameters<typeof createAgentSessionManager>[1],
): TestSessionManager {
  const { webchatRepo, connectionKindOfChannel, callers, ...rest } = deps;
  return withKeys(
    createAgentSessionManager(
      { ...rest, callers: callers ?? sessionCallers({ webchatRepo, connectionKindOfChannel }) },
      options,
    ),
  );
}

/**
 * Where a fake session records a turn, resolved the way a real one does. A
 * fake session object passes itself: `recordsTo(o) { return recordsToOf(this, o) }`.
 */
export function recordsToOf(
  fake: unknown,
  options?: Pick<SendTurnOptions, "threadContext" | "execution">,
): TurnConversation {
  const session = fake as {
    key: AgentSessionKey;
    sessionId: string;
    conversation?: SessionConversation;
  };
  return resolveTurnConversation({
    agentName: session.key.agentName,
    agentSessionId: session.sessionId,
    sessionConversation: session.conversation,
    channelThreadKey: callerKey(session.key.caller),
    threadContext: options?.threadContext,
    actionContext: options?.execution,
  });
}
