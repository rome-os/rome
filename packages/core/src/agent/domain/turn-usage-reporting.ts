import type { AgentAccounting, AgentTurnStatus } from "@rome-os/app-runtime";
import type { ModelLoginKind } from "./model-login.js";
import type { SessionKind } from "./session.js";

/** How a request for an agent's session was served: an open one, a new one, a replaced one, or one already opening. */
export type SessionServed = "reuse" | "cold" | "reopen" | "coalesced";

/** The agent a measurement is about. */
export interface ReportedAgent {
  agentName: string;
  isSubagent: boolean;
}

/** Who a model turn's tokens count against. */
export interface TurnAttribution {
  agentName: string;
  /** The app that owns the agent, when an app does. */
  owningAppId?: string;
}

/** What the session knows about a turn when it ends. */
export interface TurnUsageFacts {
  turnId: string;
  /** The chat the turn recorded in. It comes with the turn while each turn
   *  picks its own chat (ZHA-157). */
  romeSessionId: string;
  /** The kind of the session that ran the turn. */
  sessionKind: SessionKind;
  agentName: string;
  status: AgentTurnStatus;
  /** The model session that served the turn. Accounting, when present, wins. */
  provider: string;
  model: string;
  loginKind: ModelLoginKind | undefined;
  providerTurnId: string | undefined;
  accounting: AgentAccounting | undefined;
  durationMs: number | undefined;
  finishedAt: Date;
}

/**
 * Port. What the agent context reports about the sessions it serves and the
 * turns it runs, for usage events and Rome's metrics. A call never waits and
 * never fails the turn.
 */
export interface TurnUsageReporting {
  /** A caller asked for an agent's session and was served this way. */
  sessionServed(how: SessionServed, agent: ReportedAgent): void;
  /** A model session opened after `durationMs`. */
  modelSessionOpened(opened: { provider: string; resumed: boolean; durationMs: number }): void;
  /** A turn's first text arrived `afterMs` after its model turn started. */
  firstTextProduced(text: ReportedAgent & { model: string; afterMs: number }): void;
  /** A model turn ended with this accounting, a forked turn's included. */
  modelTurnAccounted(accounting: AgentAccounting | undefined, attribution: TurnAttribution): void;
  /** A model turn's prompt was checked against the model's cache, and `hit` says whether it read anything from it. */
  promptCacheChecked(cache: { model: string; isSubagent: boolean; hit: boolean }): void;
  /** An agent's turn took `durationMs` from start to its end. */
  turnTimed(agentName: string, durationMs: number): void;
  /** A turn ended. Rome records it as a usage event. */
  turnEnded(facts: TurnUsageFacts): void;
}
