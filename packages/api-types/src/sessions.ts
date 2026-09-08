import type { RomeSessionType } from "@rome-os/app-runtime";
import type { TurnEndStatus } from "./trace-segments.js";

export type SessionsRange = "24h" | "7d" | "30d" | "all";
export type SessionsMetric = "runs" | "tokens" | "cost" | "errors";
export type SessionsSort = "activity" | SessionsMetric;
/** A run's turn-end status, plus `unknown` for runs with no/other status. */
export type RunOutcome = TurnEndStatus | "unknown";
export type SessionMetricsDimension = "app" | "type" | "source" | "agent" | "model" | "project";
export type SessionMetricsInterval = "none" | "hour" | "day" | "week" | "auto";

export type SessionTimeRange =
  | { kind: "preset"; value: Exclude<SessionsRange, "all"> }
  | { kind: "absolute"; from: string; to: string }
  | { kind: "all" };

export type SessionOwnerFilter =
  | { kind: "core" }
  | { kind: "app"; appId: string }
  | { kind: "uninstalled" };

export type SessionSourceFilter = { kind: "internal" } | { kind: "channel"; channel: string };

export type SessionModelFilter =
  | { kind: "named"; provider?: string; name: string }
  | { kind: "unknown" };

export interface SessionQueryScope {
  time: SessionTimeRange;
  timeZone: string;
  sessions?: {
    ids?: string[];
    types?: RomeSessionType[];
    owners?: SessionOwnerFilter[];
    agentNames?: string[];
    sources?: SessionSourceFilter[];
    projectPathPrefix?: string;
  };
  runs?: {
    models?: SessionModelFilter[];
    outcomes?: RunOutcome[];
  };
}

export interface SessionQueryRequest {
  scope: SessionQueryScope;
  search?: string;
  sort?: { field: SessionsSort; direction?: "asc" | "desc" };
  page?: { offset?: number; limit?: number };
}

export interface SessionMetricsProjectionRequest {
  id: string;
  groupBy: SessionMetricsDimension;
  interval: SessionMetricsInterval;
  rankBy: SessionsMetric;
  limit?: number;
  includeOther?: boolean;
}

export interface SessionMetricsRequest {
  scope: SessionQueryScope;
  projections: SessionMetricsProjectionRequest[];
}

export interface RunUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costedRunCount: number;
}

export interface RunOutcomeSummary {
  completed: number;
  interrupted: number;
  error: number;
  unknown: number;
}

export interface RomeSessionOwner {
  type: "core" | "app" | "unknown";
  id: string | null;
  label: string;
  iconUrl: string | null;
}

export interface RomeSessionStats {
  runCount: number;
  usage: RunUsageSummary;
  outcomes: RunOutcomeSummary;
}

export interface RomeSessionExplorerRecord {
  id: string;
  name: string;
  displayTitle: string;
  personaId: string | null;
  largeModelSelection: string | null;
  projectName: string;
  projectPath: string | null;
  agentName: string | null;
  type: RomeSessionType;
  sourceChannel: string | null;
  sourceThreadId: string | null;
  sourceThreadName: string | null;
  sourceThreadType: string | null;
  triggerKind: string | null;
  triggerName: string | null;
  triggerActionName: string | null;
  triggerExecutionId: string | null;
  rootActionExecutionId: string | null;
  parentActionExecutionId: string | null;
  parentSessionId: string | null;
  parentTurnId: string | null;
  createdAt: string;
  activityAt: string;
  messageCount: number;
  owner: RomeSessionOwner;
  stats: RomeSessionStats;
}

export interface RomeSessionsPageResult {
  sessions: RomeSessionExplorerRecord[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  facets: {
    types: { value: string | null; count: number }[];
    sourceChannels: { value: string | null; count: number }[];
  };
}

export type SessionMetricDimensionValue =
  | {
      dimension: "app";
      state: "core" | "installed";
      appId: string;
      label: string;
      iconUrl: string | null;
    }
  | {
      dimension: "app";
      state: "uninstalled";
      appId: null;
      label: string;
      iconUrl: null;
    }
  | {
      dimension: "model";
      state: "known";
      provider: string | null;
      name: string;
      label: string;
    }
  | { dimension: "model"; state: "unknown"; label: string }
  | { dimension: "source"; state: "internal"; channel: null; label: string }
  | { dimension: "source"; state: "channel"; channel: string; label: string }
  | { dimension: "type"; value: string; label: string }
  | { dimension: "agent"; name: string; label: string }
  | { dimension: "project"; path: string | null; label: string }
  | { dimension: "other"; label: string };

export interface SessionMetricValue extends RomeSessionStats {
  key: string;
  sessionCount: number;
}

export interface SessionMetricGroup extends SessionMetricValue {
  dimension: SessionMetricDimensionValue;
  label: string;
  description: string | null;
  iconUrl: string | null;
  kind: "named" | "unknown" | "other";
  lastActivityAt: string;
}

export interface SessionMetricsBucket extends RomeSessionStats {
  bucket: string;
  sessionCount: number;
  values: SessionMetricValue[];
}

export interface SessionMetricsProjection {
  id: string;
  groupBy: SessionMetricsDimension;
  interval: SessionMetricsInterval;
  rankBy: SessionsMetric;
  groups: SessionMetricGroup[];
  buckets: SessionMetricsBucket[];
}

export interface SessionMetricsResponse {
  scope: { from: string | null; to: string; timeZone: string };
  totals: RomeSessionStats & { sessionCount: number };
  projections: SessionMetricsProjection[];
}

export interface RomeSessionLineageEntry {
  id: string;
  displayTitle: string;
  type: RomeSessionType;
  agentName: string | null;
  parentTurnId: string | null;
  activityAt: string;
}

export interface RomeSessionLineage {
  parent: RomeSessionLineageEntry | null;
  children: RomeSessionLineageEntry[];
}

export interface RomeSessionDetail extends RomeSessionExplorerRecord {
  lineage: RomeSessionLineage;
}

export type { RomeSessionType };
