// Usage events this instance reports to Rome Cloud.
// Contract: docs/concepts/rome-cloud.md#usage-reporting.

import type { AgentTurnStatus } from "@rome-os/app-runtime";

/** Where the work came from. Subagent and fork turns take their root's kind. */
export type UsageKind = "chat" | "channel" | "app" | "routine" | "other";

/** Who paid the model provider for a turn. */
export type UsageFunding = "rome_credits" | "byok" | "subscription" | "unknown";

export interface TurnUsageEvent {
  type: "turn";
  /** The Rome turn id. */
  eventId: string;
  kind: UsageKind;
  /** App Store listing id, `local` for an app from outside the store, or null. */
  appId: string | null;
  status: AgentTurnStatus;
  provider: string;
  model: string | null;
  funding: UsageFunding;
  /** The provider's own turn id. Rome Cloud joins credit charges on it. */
  providerTurnId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** List-price estimate in microdollars, as a decimal string. Never a charge. */
  estimatedCostMicros: string | null;
  durationMs: number | null;
  occurredAt: string;
}

export interface ActionRunUsageEvent {
  type: "action_run";
  /** The root action execution id. */
  eventId: string;
  kind: "app" | "routine";
  appId: string | null;
  status: "success" | "error" | "cancelled";
  durationMs: number | null;
  occurredAt: string;
}

export type UsageEvent = TurnUsageEvent | ActionRunUsageEvent;
