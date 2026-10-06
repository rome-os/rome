import type { RomeSessionType } from "@rome-os/app-runtime";
import type { UsageKind } from "./events.js";

// A subagent can delegate again, and a fork can be forked. Lineage deeper than
// this is treated as unreachable rather than walked further.
const MAX_LINEAGE_DEPTH = 16;

interface SessionRow {
  type: string;
  agentName: string | null;
  parentSessionId: string | null;
  triggerExecutionId: string | null;
  rootActionExecutionId: string | null;
  triggerActionName: string | null;
}

export interface UsageAttributionSources {
  getSession(id: string): Promise<SessionRow | null>;
  getExecutionInitiator(executionId: string): Promise<string | null>;
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
}

/**
 * Resolves where a turn or an action run came from. Lineage is read from the
 * stored session rows when the event is recorded, so a child session's usage
 * is attributed without copying anything onto the parent.
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
    const own = await this.sources.getSession(params.romeSessionId);
    if (!own) {
      return { kind: kindForSessionType(params.fallbackType) ?? "other", appId: agentAppId };
    }
    let session: SessionRow = own;
    for (let depth = 0; isChildSession(session) && depth < MAX_LINEAGE_DEPTH; depth++) {
      const parent: SessionRow | null = session.parentSessionId
        ? await this.sources.getSession(session.parentSessionId)
        : null;
      if (!parent) break;
      session = parent;
    }
    const direct = kindForSessionType(session.type);
    if (direct) return { kind: direct, appId: agentAppId };
    if (session.type !== "action") return { kind: "other", appId: agentAppId };

    // Every execution in a chain carries the chain's initiator. The execution
    // that started the agent is a stored row. A routine's root id is not.
    const executionId = session.triggerExecutionId ?? session.rootActionExecutionId;
    const initiator = executionId ? await this.sources.getExecutionInitiator(executionId) : null;
    const fromInitiator = this.fromInitiator(initiator);
    if (fromInitiator) return { ...fromInitiator, appId: fromInitiator.appId ?? agentAppId };
    const actionAppId = session.triggerActionName
      ? this.apps.forAction(session.triggerActionName)
      : null;
    if (actionAppId) return { kind: "app", appId: actionAppId };
    return { kind: "other", appId: agentAppId };
  }

  /**
   * Attribution for a finished top-level action execution, or null when it is
   * not reported. A routine fire, an app's own call, and a webhook into an
   * app's action are reported. An agent's tool call, channel delivery, and
   * startup work are not: their model work is already counted by turn events.
   */
  forActionRun(row: {
    actionName: string;
    initiator: string | null;
  }): (UsageAttribution & { kind: "app" | "routine" }) | null {
    const actionAppId = this.apps.forAction(row.actionName);
    const fromInitiator = this.fromInitiator(row.initiator);
    if (fromInitiator) return { ...fromInitiator, appId: fromInitiator.appId ?? actionAppId };
    if (row.initiator === "webhook" && actionAppId) return { kind: "app", appId: actionAppId };
    return null;
  }

  // Initiators are `routine:<name>` and `app:<appId>`, among others that do
  // not decide the kind. Routine names stay on the instance.
  private fromInitiator(
    initiator: string | null,
  ): (UsageAttribution & { kind: "app" | "routine" }) | null {
    if (initiator?.startsWith("routine:")) return { kind: "routine", appId: null };
    if (initiator?.startsWith("app:")) {
      return { kind: "app", appId: this.apps.forApp(initiator.slice("app:".length)) };
    }
    return null;
  }
}

function isChildSession(session: SessionRow): boolean {
  return session.type === "subagent" || session.type === "fork";
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
