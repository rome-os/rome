// Rome's side of three ports behind a session's Rome tools: the actions an
// agent may call, scheduling a deferred wake, and the session's own tools.
// The agent context assembles the tool groups from them (`createRomeTools`).
// Vocabulary: docs/domains/agents.md#rome-tools.

import type { ThreadContext } from "@rome-os/app-runtime";
import type {
  AgentAction,
  AgentActions,
  DeferTool,
  RomeTool,
  SessionTools,
  TurnFacts,
} from "../agent/index.js";
import type { ActionEngine } from "../apps/actions/engine.js";
import type { Action, ActionRegistry, ActionResult } from "../apps/actions/types.js";
import { validateActionArgs } from "../apps/actions/validate-action-args.js";
import type { WebChatRepository } from "../webchat/repository.js";
import type { EventSources } from "../events/event-sources.js";
import { chatRoutineKeyForToolUse } from "../routines/chat-routine-key.js";
import { runDefer } from "../routines/defer.js";
import {
  proposeRoutineTools,
  type RoutineActivationGate,
} from "../routines/propose-routine-tool.js";
import type { SessionToolsProvider } from "./session-tools.js";
import { connectAccountTools } from "./connect-account-tool.js";
import { withoutSessionActor, type SessionActor } from "../access/session-actor.js";

export interface RomeToolPortsDeps {
  actionRegistry: ActionRegistry;
  actionEngine: ActionEngine;
  /** App-declared event sources: an event `defer` subscribes through them.
   *  When absent, an event wait is created without any check. */
  eventSources?: EventSources;
  /** Whose a dashboard chat is, for a wake scheduled in one. */
  webchatRepo?: Pick<WebChatRepository, "getSession">;
  /** The tools Rome adds for an agent. When absent, a session carries none. */
  sessionTools?: SessionToolsProvider;
  /**
   * Whose task `taskId` is, or null when there is none, so a check names only
   * a task of its own chat's owner. When absent, no check names a task.
   */
  taskOwner?: (taskId: string) => Promise<string | null>;
}

export interface RomeToolPorts {
  actions: AgentActions;
  defer: Pick<DeferTool, "schedule">;
  sessionTools: SessionTools;
}

/** Rome's actions, routines and session tools, as the ports a session's Rome tools take. */
export function romeToolPorts(deps: RomeToolPortsDeps): RomeToolPorts {
  const { actionRegistry, actionEngine, eventSources } = deps;

  // A tool callback arrives in whatever async scope the model's process
  // delivers it in, never the request that admitted the turn, so the ambient
  // actor there belongs to someone else or to no one. The turn's own actor,
  // captured at admission, stands instead; a turn no person started acts for
  // no one. The webchat route puts a SessionActor there.
  const asTurnActor = <T>(turn: TurnFacts, fn: (actor: SessionActor | undefined) => T): T =>
    withoutSessionActor(() => fn(turn.actor() as SessionActor | undefined));

  // The registry's `getForAgent` is the single resolution point for what an
  // agent may call: its allow-list, or everything for "*". Both the
  // model-facing catalog and the execution gate derive from it, so they can't
  // disagree. It's consulted per request, so an action installed
  // mid-conversation by `app_management` is callable in the same session.
  const findPermittedAction = (turn: TurnFacts, name: string): Action | undefined => {
    const requestedAction = actionRegistry.get(name);
    if (!requestedAction) throw new Error(`Unknown action: ${name}`);
    return actionRegistry
      .getForAgent([...turn.actions])
      .find((action) => action.config.name === requestedAction.config.name);
  };

  const actions: AgentActions = {
    list: (turn) => actionRegistry.getForAgent([...turn.actions]).map(toAgentAction),
    appOf: (name) => {
      const metadata = actionRegistry.getMetadata?.(name);
      return metadata?.ownerType === "app" ? metadata.ownerId : undefined;
    },
    permits: (turn, name) => {
      const canonical = actionRegistry.getCanonicalName?.(name) ?? name;
      return actionRegistry
        .getForAgent([...turn.actions])
        .some((action) => action.config.name === canonical);
    },
    run: (turn, name, input) =>
      turn.inTurn(() =>
        asTurnActor(turn, async (actor) => {
          // Allow-list check is load-bearing for security: an agent yaml that
          // scopes `actions: [foo]` must not reach anything else in the registry.
          const action = findPermittedAction(turn, name);
          if (!action) throw new Error(`Unknown action: ${name}`);
          return actionEngine.run(action.config.name, input as Record<string, unknown>, {
            initiator: `agent:${turn.agentName}`,
            ...(actor ? { actor } : {}),
            channelContext: turn.threadContext(),
            sharedContext: turn.sharedContext(),
            sessionId: turn.sessionId,
            agentName: turn.agentName,
            channelThreadKey: turn.continuityKey,
            turnId: turn.turnId(),
          });
        }),
      ),
  };

  // Actions `defer` runs on the agent's behalf are attributed to its turn.
  const agentRunContext = (turn: TurnFacts) => ({
    initiator: `agent:${turn.agentName}`,
    ...(turn.actor() ? { actor: turn.actor() as SessionActor } : {}),
    sessionId: turn.sessionId,
    agentName: turn.agentName,
    channelThreadKey: turn.continuityKey,
    turnId: turn.turnId(),
  });

  // `defer` creates its one-off through `create_routine` directly, not through
  // the agent's action allow-list: `defer` is a built-in.
  const defer: Pick<DeferTool, "schedule"> = {
    schedule: (turn, wakeUp) =>
      turn.inTurn(() =>
        asTurnActor(turn, async () => {
          const ownerKey = await dashboardChatOwner(deps.webchatRepo, turn.threadContext());
          // A check names only a task of the owner whose chat schedules it.
          if (wakeUp.taskId) {
            const owner = (await deps.taskOwner?.(wakeUp.taskId)) ?? null;
            if (owner === null || owner !== (ownerKey ?? "guardian")) {
              throw new Error(`No task ${wakeUp.taskId}. Use task_list to find it.`);
            }
          }
          return runDefer(wakeUp, {
            context: {
              agentName: turn.agentName,
              sessionId: turn.sessionId,
              channelContext: turn.threadContext(),
              ownerKey,
              turnId: turn.turnId(),
              scheduledAt: new Date(),
            },
            createRoutine: async (createArgs) => {
              const result = await actionEngine.run(
                "create_routine",
                createArgs,
                agentRunContext(turn),
              );
              if (result.status === "error") throw new Error(result.error);
              if (result.status !== "ok") {
                throw new Error(`create_routine returned ${result.status}`);
              }
              return result.data;
            },
            prepareEventWait: eventSources
              ? (eventName, filter) =>
                  eventSources.prepareWait(eventName, filter, (name, args) =>
                    actionEngine.run(name, args, agentRunContext(turn)),
                  )
              : undefined,
          });
        }),
      ),
  };

  // `propose_routine` auto-enables only a routine the agent could already
  // create with `create_routine` itself (the same check, non-throwing), with
  // args that fit the target action's schema.
  const routineActivation = (turn: TurnFacts): RoutineActivationGate => ({
    canCallAction: (name) => {
      if (!actionRegistry.get(name)) return "unknown";
      return findPermittedAction(turn, name) ? "permitted" : "denied";
    },
    validateArgs: (actionName, args) => {
      const action = actionRegistry.get(actionName);
      return validateActionArgs(action?.config.name ?? actionName, args, action?.inputSchema);
    },
    // The live turn's id is the one the webchat drain sees on its handle.
    routineKeyFor: (toolUseId) => {
      const turnId = turn.turnId();
      return turnId ? chatRoutineKeyForToolUse(turnId, toolUseId) : undefined;
    },
  });

  const sessionTools: SessionTools = {
    async forTurn(turn, hasSpeaker) {
      // A turn with no speaker is a fork's, which serves its source's session
      // tools and runs only its own `propose_routine` (`forkSessionTools`).
      const provided = hasSpeaker
        ? ((await deps.sessionTools?.({
            agentName: turn.agentName,
            channelThreadKey: turn.continuityKey,
            sessionId: turn.sessionId,
            isSubagent: turn.isSubagent,
            getTurnId: turn.turnId,
            getThreadContext: turn.threadContext,
            getTurnPushLevel: turn.pushLevel,
            getTurnReportedTask: turn.reportedTask,
          })) ?? [])
        : [];
      return [
        ...provided,
        // With no speaker the handler refuses, since nothing would mount its card.
        ...proposeRoutineTools({
          widgets: turn.widgets,
          hasSpeaker,
          gate: routineActivation(turn),
          runAction: (name: string, input: unknown): Promise<ActionResult> =>
            actions.run(turn, name, input),
        }),
        ...connectAccountTools({ widgets: turn.widgets, hasSpeaker }),
      ];
    },
  };

  return { actions, defer, sessionTools };
}

function toAgentAction(a: Action): AgentAction {
  return {
    name: a.config.name,
    description: a.config.description,
    type: a.config.type,
    complexity: a.config.complexity,
    speed: a.config.speed,
    reliability: a.config.reliability,
    sideEffects: a.config.sideEffects,
    requiresApproval: !!a.config.requiresApproval,
    cancellable: !!a.config.cancellable,
    inputSchema: a.inputSchema!,
  };
}

/** Whose a dashboard chat is, for work scheduled in it; undefined for any other thread. */
async function dashboardChatOwner(
  webchatRepo: Pick<WebChatRepository, "getSession"> | undefined,
  thread: ThreadContext | undefined,
): Promise<string | undefined> {
  if (thread?.channel !== "webchat" || !thread.threadId || !webchatRepo) return undefined;
  const chat = await webchatRepo.getSession(thread.threadId);
  return chat ? (chat.ownerKey ?? "guardian") : undefined;
}
