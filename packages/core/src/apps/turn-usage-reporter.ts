// Reports sessions and turns to Rome's OpenTelemetry metrics, and ended turns
// to the usage recorder.

import type { AppCatalog } from "./catalog.js";
import {
  modelPromptCacheMetric,
  modelSessionOpenMetric,
  modelTurnTtftMetric,
  recordModelTurnMetrics,
  sessionAcquireMetric,
  sessionDurationMetric,
} from "../telemetry.js";
import type {
  ReportedAgent,
  SessionServed,
  TurnAttribution,
  TurnUsageFacts,
  TurnUsageReporting,
} from "../agent/index.js";
import type { AgentAccounting } from "@rome-os/app-runtime";

export interface TurnUsageReporterDeps {
  /** Records each ended turn as a usage event. Absent, an ended turn is not recorded. */
  usage?: { recordTurn(facts: TurnUsageFacts): void };
  /** Finds the app that owns an agent, whose store listing a model turn's tokens are labelled with. */
  apps?: Pick<AppCatalog, "get">;
}

export class TurnUsageReporter implements TurnUsageReporting {
  constructor(private readonly deps: TurnUsageReporterDeps = {}) {}

  sessionServed(how: SessionServed, agent: ReportedAgent): void {
    sessionAcquireMetric().add(1, {
      outcome: how,
      "agent.name": agent.agentName,
      is_subagent: agent.isSubagent,
    });
  }

  modelSessionOpened(opened: { provider: string; resumed: boolean; durationMs: number }): void {
    modelSessionOpenMetric().record(opened.durationMs, {
      provider: opened.provider,
      resumed: opened.resumed,
    });
  }

  firstTextProduced(text: ReportedAgent & { model: string; afterMs: number }): void {
    modelTurnTtftMetric().record(text.afterMs, {
      "model.id": text.model,
      "agent.name": text.agentName,
      is_subagent: text.isSubagent,
    });
  }

  modelTurnAccounted(accounting: AgentAccounting | undefined, attribution: TurnAttribution): void {
    const app = attribution.owningAppId ? this.deps.apps?.get(attribution.owningAppId) : undefined;
    recordModelTurnMetrics(accounting, {
      agentName: attribution.agentName,
      appStoreListingId: app?.source.mode === "appstore" ? app.source.listingId : undefined,
    });
  }

  promptCacheChecked(cache: { model: string; isSubagent: boolean; hit: boolean }): void {
    modelPromptCacheMetric().add(1, {
      outcome: cache.hit ? "hit" : "miss",
      "model.id": cache.model,
      is_subagent: cache.isSubagent,
    });
  }

  turnTimed(agentName: string, durationMs: number): void {
    sessionDurationMetric().record(durationMs, { "agent.name": agentName });
  }

  turnEnded(facts: TurnUsageFacts): void {
    this.deps.usage?.recordTurn(facts);
  }
}
