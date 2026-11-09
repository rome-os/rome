import type { RomeSessionType } from "@rome-os/app-runtime";
import type { SessionActor } from "../access/session-actor.js";
import type { UsageKind, UsageTrigger } from "./events.js";

/** The initiator of the skill review core starts after a main-agent turn. */
export const SKILL_REVIEW_INITIATOR = "system:skill-review";

interface SessionRow {
  type: string;
  agentName: string | null;
  triggerExecutionId: string | null;
  rootActionExecutionId: string | null;
  triggerActionName: string | null;
}

interface ExecutionRow {
  initiator: string | null;
  actor: SessionActor | null;
  rootExecutionId: string;
}

export interface UsageAttributionSources {
  getSession(id: string): Promise<SessionRow | null>;
  /** The root session of the session `id`, by the dashboard's id, or null
   *  when there is no such session (the agent context's `rootSession`). */
  rootSession(id: string): Promise<string | null>;
  getExecution(executionId: string): Promise<ExecutionRow | null>;
  /**
   * What fired the routine run rooted at `rootExecutionId`: a trigger type, or
   * `run_now` for a manual run. Null when that is not known.
   */
  getRoutineFiredBy(params: {
    rootExecutionId: string;
    routineName: string;
  }): Promise<string | null>;
}

/**
 * The app ids usage events report. Each method returns the App Store listing
 * id, `local` for an app installed from outside the store, or null when no app
 * owns the thing named.
 */
export interface UsageAppDirectory {
  forAgent(agentName: string): string | null;
  forAction(actionName: string): string | null;
  forApp(appId: string): string | null;
}

export interface UsageAttribution {
  kind: UsageKind;
  appId: string | null;
  trigger: UsageTrigger;
}

/**
 * Resolves where a turn or an action run came from. A child session's root is
 * found when the event is recorded, so its usage is attributed without
 * copying anything onto the parent.
 */
export class UsageAttributionResolver {
  constructor(
    private readonly sources: UsageAttributionSources,
    private readonly apps: UsageAppDirectory,
  ) {}

  /**
   * Attribution for a turn of `romeSessionId`, run by `agentName`. A subagent
   * or fork turn takes the kind of its root session. When the session row is
   * missing, `fallbackType` (the type the turn ran under) decides the kind.
   */
  async forTurn(params: {
    romeSessionId: string;
    fallbackType: RomeSessionType;
    agentName: string;
  }): Promise<UsageAttribution> {
    const agentAppId = this.apps.forAgent(params.agentName);
    const rootId = await this.sources.rootSession(params.romeSessionId);
    const session = rootId ? await this.sources.getSession(rootId) : null;
    if (!session) {
      const kind = kindForSessionType(params.fallbackType);
      return kind
        ? { kind, appId: agentAppId, trigger: "user" }
        : { kind: "other", appId: agentAppId, trigger: "unknown" };
    }
    const direct = kindForSessionType(session.type);
    if (direct) return { kind: direct, appId: agentAppId, trigger: "user" };
    if (session.type !== "action") return { kind: "other", appId: agentAppId, trigger: "unknown" };

    // Every execution in a chain carries the chain's initiator and actor. The
    // execution that started the agent is a stored row. A routine's root id is
    // not, but its routine run is keyed by it.
    const executionId = session.triggerExecutionId ?? session.rootActionExecutionId;
    const execution = executionId ? await this.sources.getExecution(executionId) : null;
    const initiator = execution?.initiator ?? null;
    const trigger = await this.triggerFor({
      initiator,
      actor: execution?.actor ?? null,
      rootExecutionId: session.rootActionExecutionId ?? execution?.rootExecutionId ?? null,
    });
    const fromInitiator = this.fromInitiator(initiator);
    if (fromInitiator) {
      return { ...fromInitiator, appId: fromInitiator.appId ?? agentAppId, trigger };
    }
    const actionAppId = session.triggerActionName
      ? this.apps.forAction(session.triggerActionName)
      : null;
    if (actionAppId) return { kind: "app", appId: actionAppId, trigger };
    return { kind: "other", appId: agentAppId, trigger };
  }

  /**
   * Attribution for a finished top-level action execution, or null when it is
   * not reported. A routine fire, an app's own call, and a webhook into an
   * app's action are reported. An agent's tool call, channel delivery, and
   * startup work are not: their model work is already counted by turn events.
   */
  async forActionRun(
    row: ExecutionRow & { actionName: string },
  ): Promise<(UsageAttribution & { kind: "app" | "routine" }) | null> {
    const actionAppId = this.apps.forAction(row.actionName);
    const fromInitiator = this.fromInitiator(row.initiator);
    const reported = fromInitiator
      ? { ...fromInitiator, appId: fromInitiator.appId ?? actionAppId }
      : row.initiator === "webhook" && actionAppId
        ? { kind: "app" as const, appId: actionAppId }
        : null;
    return reported ? { ...reported, trigger: await this.triggerFor(row) } : null;
  }

  // A person in the chain wins. Otherwise a routine run reports what fired it,
  // a webhook is an event, and an app's own call has no person behind it. A
  // guardian reached over loopback is the agent or a CLI in the container. A
  // sessionless caller may be a machine posting to an app's open route.
  private async triggerFor(params: {
    initiator: string | null;
    actor: SessionActor | null;
    rootExecutionId: string | null;
  }): Promise<UsageTrigger> {
    const { initiator, actor } = params;
    if (actor?.kind === "visitor" || (actor?.kind === "guardian" && actor.via === "cookie")) {
      return "user";
    }
    if (actor?.kind === "guardian") return "background";
    if (initiator?.startsWith("routine:") && params.rootExecutionId) {
      const firedBy = await this.sources.getRoutineFiredBy({
        rootExecutionId: params.rootExecutionId,
        routineName: initiator.slice("routine:".length),
      });
      return triggerForRoutineFire(firedBy);
    }
    if (initiator === "webhook") return "event";
    if (initiator?.startsWith("app:")) return "background";
    if (initiator === SKILL_REVIEW_INITIATOR) return "background";
    return "unknown";
  }

  // Initiators are `routine:<name>` and `app:<appId>`, among others that do
  // not decide the kind. Routine names stay on the instance.
  private fromInitiator(
    initiator: string | null,
  ): Omit<UsageAttribution & { kind: "app" | "routine" }, "trigger"> | null {
    if (initiator?.startsWith("routine:")) return { kind: "routine", appId: null };
    if (initiator?.startsWith("app:")) {
      return { kind: "app", appId: this.apps.forApp(initiator.slice("app:".length)) };
    }
    return null;
  }
}

function triggerForRoutineFire(firedBy: string | null): UsageTrigger {
  switch (firedBy) {
    case "run_now":
    case "manual":
      return "user";
    case "schedule":
      return "schedule";
    case "event-bus":
      return "event";
    default:
      return "unknown";
  }
}

function kindForSessionType(type: string): UsageKind | null {
  switch (type) {
    case "webchat":
    case "webchat_handoff":
      return "chat";
    case "channel":
      return "channel";
    default:
      return null;
  }
}
