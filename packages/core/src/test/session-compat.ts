// Test-only: the old key-string entry points over the Sessions API, so the
// manager's own tests keep their fixtures while the API changes under them.

import {
  type AgentSession,
  type AgentSessionManager,
  createAgentSessionManager,
  type ManagerDeps,
  sessionBehind,
  type SessionOpenOptions,
  type SurfaceKeeps,
} from "../agent-sessions/agent-session.js";
import type { ConnectionKindOfChannel } from "../db/repositories/channel-records.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { chatModelSelection } from "../core/chat-model-selection.js";
import { callerFromKey } from "../core/session-caller.js";
import { createSessionLog, openNamed } from "../agent-sessions/rows/session-log.js";
import {
  type ChannelSurface,
  sessionSurfaceOf,
  type SurfaceDeps,
} from "../connections/session-surface.js";
import type { ModelReasoningEffort } from "../core/agent-runner.js";
import type { ModelSelectionId } from "../core/model-selector.js";
import type { ThreadContext } from "../core/types.js";
import type { SessionConversation } from "../agent-sessions/rows/session-conversation.js";
import { chatRoutineKeyForToolUse } from "../routines/chat-routine-key.js";

export interface StoredKey {
  agentName: string;
  channelThreadKey: string;
}

/** The options sessions opened with before the surface. */
export interface KeyedInit {
  workingDir?: string;
  threadContext?: ThreadContext;
  contextSuffix?: string;
  selectionId?: ModelSelectionId | null;
  reasoningEffort?: ModelReasoningEffort;
  /** The conversation the caller named. */
  romeSessionId?: string;
  resumeSessionId?: string;
  keeps?: SurfaceKeeps;
  /** Overrides whether the surface shows cards. */
  cards?: boolean;
}

export interface TestSessionManager extends AgentSessionManager {
  acquire(key: StoredKey, init?: KeyedInit): Promise<AgentSession>;
  acquireBySessionId(id: string, agentName: string, init?: KeyedInit): Promise<AgentSession>;
  peek(key: StoredKey): AgentSession | undefined;
}

function openOptions(init: KeyedInit | undefined): SessionOpenOptions {
  return {
    ...(init?.workingDir !== undefined ? { workingDir: init.workingDir } : {}),
    ...(init?.selectionId !== undefined ? { model: init.selectionId } : {}),
    ...(init?.reasoningEffort !== undefined ? { effort: init.reasoningEffort } : {}),
  };
}

/** `manager` with the old key-string entry points, lending the surface the
 *  old options described. */
export function withKeys(
  manager: AgentSessionManager,
  surfaceDeps: SurfaceDeps = {},
): TestSessionManager {
  const keyed = manager as TestSessionManager;
  const surfaceOf = (key: string | undefined, init: KeyedInit | undefined) => {
    const replies = init?.threadContext;
    const surface = sessionSurfaceOf(surfaceDeps, key ? callerFromKey(key) : undefined, replies, {
      ...(init?.keeps ? { keeps: init.keeps } : {}),
      ...(init?.contextSuffix ? { about: init.contextSuffix } : {}),
    });
    return init?.cards === undefined ? surface : { ...surface, cards: init.cards };
  };
  keyed.acquire = (key, init) =>
    init?.resumeSessionId
      ? manager.session(
          init.resumeSessionId,
          key.agentName,
          surfaceOf(key.channelThreadKey, init),
          openOptions(init),
        )
      : openNamed(key.channelThreadKey, init?.romeSessionId, () =>
          manager.open(
            key.agentName,
            key.channelThreadKey,
            surfaceOf(key.channelThreadKey, init),
            openOptions(init),
          ),
        );
  keyed.acquireBySessionId = (id, agentName, init) =>
    manager.session(id, agentName, surfaceOf(undefined, init), openOptions(init));
  keyed.peek = (key) => manager.live(key.agentName, key.channelThreadKey);
  return keyed;
}

export type LegacyManagerDeps = Omit<ManagerDeps, "log"> & {
  log?: ManagerDeps["log"];
  webchatRepo?: WebChatRepository;
  connectionKindOfChannel?: ConnectionKindOfChannel;
  channelSurface?: (channel: string) => ChannelSurface | null;
};

/** A manager whose log writes to `webchatRepo` and whose surfaces answer
 *  from the connection kinds, as production wires them. */
export function createTestSessionManager(
  deps: LegacyManagerDeps,
  options?: Parameters<typeof createAgentSessionManager>[1],
): TestSessionManager {
  const { webchatRepo, connectionKindOfChannel, channelSurface, log, ...rest } = deps;
  return withKeys(
    createAgentSessionManager(
      {
        ...rest,
        log: log ?? createSessionLog(webchatRepo),
        routineKeyFor: rest.routineKeyFor ?? chatRoutineKeyForToolUse,
        // As index.ts wires it: a session resumed by id restores its chat's
        // model.
        rememberedModel:
          rest.rememberedModel ??
          ((caller, agentName, pinned) =>
            chatModelSelection(webchatRepo)(callerFromKey(caller), agentName, pinned)),
      },
      options,
    ),
    { connectionKindOfChannel, ...(channelSurface ? { channelSurface } : {}) },
  );
}

/** Where a real session keeps its turns in today's rows, which only the
 *  session reads. */
export function conversationOf(session: AgentSession): SessionConversation | undefined {
  return (sessionBehind(session) as unknown as { conversation?: SessionConversation }).conversation;
}
