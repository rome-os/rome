import { basename } from "node:path";
import { artifactLocalName } from "../apps/artifact-id.js";
import type {
  RomeSessionDetail,
  RomeSessionExplorerRecord,
  RomeSessionOwner,
  RomeSessionStats,
  RomeSessionsPageResult,
  RunOutcomeSummary,
  RunUsageSummary,
  SessionMetricDimensionValue,
  SessionMetricGroup,
  SessionMetricsDimension,
  SessionMetricsInterval,
  SessionMetricsProjection,
  SessionMetricsProjectionRequest,
  SessionMetricsRequest,
  SessionMetricsResponse,
  SessionQueryRequest,
  SessionQueryScope,
  SessionsMetric,
  SessionModelIdentity,
} from "@rome/api-types/sessions";
import type { RomeSessionType } from "@rome-os/app-runtime";
import type {
  RawSessionRunAggregate,
  RawSessionModelIdentity,
  RawSessionStats,
  SessionQueryRepository,
  SessionQueryStorageScope,
} from "../db/repositories/session-query.js";

type SessionRow = NonNullable<
  Awaited<ReturnType<SessionQueryRepository["getSessionDetailRows"]>>
>["session"];

type MetricsAccumulator = {
  sessions: Set<string>;
  runCount: number;
  usage: RunUsageSummary;
  outcomes: RunOutcomeSummary;
  lastActivityAt: Date | null;
};

type DimensionMetadata = {
  key: string;
  label: string;
  description: string | null;
  iconUrl: string | null;
  kind: "named" | "unknown";
  dimension: SessionMetricDimensionValue;
};

export interface SessionQueryServiceOptions {
  repository: SessionQueryRepository;
  agentLoader: {
    getRecord(name: string): {
      metadata: { ownerType: "core" | "app"; ownerId: string };
    };
    getAllResolvableRecords(): Map<
      string,
      { metadata: { ownerType: "core" | "app"; ownerId: string } }
    >;
  };
  appCatalog: {
    listResolved(): readonly {
      appId: string;
      displayName: string;
      iconAbsolutePath?: string | null;
    }[];
  };
  now?: () => Date;
}

function emptyUsage(): RunUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: null,
    costedRunCount: 0,
  };
}

function emptyOutcomes(): RunOutcomeSummary {
  return { completed: 0, interrupted: 0, error: 0, unknown: 0 };
}

function emptyAccumulator(): MetricsAccumulator {
  return {
    sessions: new Set(),
    runCount: 0,
    usage: emptyUsage(),
    outcomes: emptyOutcomes(),
    lastActivityAt: null,
  };
}

function appendAggregate(target: MetricsAccumulator, run: RawSessionRunAggregate): void {
  target.sessions.add(run.sessionId);
  target.runCount += run.runCount;
  target.usage.inputTokens += run.inputTokens;
  target.usage.outputTokens += run.outputTokens;
  target.usage.cacheReadTokens += run.cacheReadTokens;
  target.usage.cacheWriteTokens += run.cacheWriteTokens;
  target.usage.totalTokens +=
    run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens;
  if (run.costedRunCount > 0 && run.costUsd !== null) {
    target.usage.costUsd = (target.usage.costUsd ?? 0) + run.costUsd;
    target.usage.costedRunCount += run.costedRunCount;
  }
  target.outcomes.completed += run.completed;
  target.outcomes.interrupted += run.interrupted;
  target.outcomes.error += run.error;
  target.outcomes.unknown += run.unknown;
  if (!target.lastActivityAt || run.createdAt > target.lastActivityAt) {
    target.lastActivityAt = run.createdAt;
  }
}

function mergeAccumulator(target: MetricsAccumulator, source: MetricsAccumulator): void {
  for (const sessionId of source.sessions) target.sessions.add(sessionId);
  target.runCount += source.runCount;
  target.usage.inputTokens += source.usage.inputTokens;
  target.usage.outputTokens += source.usage.outputTokens;
  target.usage.cacheReadTokens += source.usage.cacheReadTokens;
  target.usage.cacheWriteTokens += source.usage.cacheWriteTokens;
  target.usage.totalTokens += source.usage.totalTokens;
  if (source.usage.costUsd !== null) {
    target.usage.costUsd = (target.usage.costUsd ?? 0) + source.usage.costUsd;
  }
  target.usage.costedRunCount += source.usage.costedRunCount;
  target.outcomes.completed += source.outcomes.completed;
  target.outcomes.interrupted += source.outcomes.interrupted;
  target.outcomes.error += source.outcomes.error;
  target.outcomes.unknown += source.outcomes.unknown;
  if (
    source.lastActivityAt &&
    (!target.lastActivityAt || source.lastActivityAt > target.lastActivityAt)
  ) {
    target.lastActivityAt = source.lastActivityAt;
  }
}

function accumulatorStats(accumulator: MetricsAccumulator): RomeSessionStats {
  return {
    runCount: accumulator.runCount,
    usage: { ...accumulator.usage },
    outcomes: { ...accumulator.outcomes },
  };
}

function storageStats(stats: RawSessionStats): RomeSessionStats {
  const usage = {
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cacheReadTokens: stats.cacheReadTokens,
    cacheWriteTokens: stats.cacheWriteTokens,
    totalTokens:
      stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheWriteTokens,
    costUsd: stats.costedRunCount > 0 ? stats.costUsd : null,
    costedRunCount: stats.costedRunCount,
  };
  return {
    runCount: stats.runCount,
    usage,
    outcomes: {
      completed: stats.completed,
      interrupted: stats.interrupted,
      error: stats.error,
      unknown: stats.unknown,
    },
  };
}

function sessionModels(rows: RawSessionModelIdentity[]): SessionModelIdentity[] {
  return rows.map((row) =>
    row.name
      ? { kind: "known" as const, provider: row.provider, name: row.name }
      : { kind: "unknown" as const },
  );
}

function metricValue(accumulator: MetricsAccumulator, metric: SessionsMetric): number {
  if (metric === "tokens") return accumulator.usage.totalTokens;
  if (metric === "cost") return accumulator.usage.costUsd ?? 0;
  if (metric === "errors") return accumulator.outcomes.error;
  return accumulator.runCount;
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function shortIdentifier(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function sessionTypeLabel(type: string): string {
  return (
    {
      webchat: "Chat",
      webchat_handoff: "Handoff",
      channel: "Channel",
      action: "Automation",
      subagent: "Subagent",
      fork: "Branch",
    }[type] ?? titleCase(type)
  );
}

function sessionDisplayTitle(session: SessionRow, owner: RomeSessionOwner): string {
  const clean = (value?: string | null) => value?.trim() || null;
  const humanize = (value?: string | null) => {
    const source = clean(value);
    if (!source) return null;
    const localName = artifactLocalName(source);
    const ownerPrefixes = owner.id ? [`${owner.id}_`, `${owner.id}-`] : [];
    const withoutOwner = ownerPrefixes.reduce(
      (current, prefix) => (current.startsWith(prefix) ? current.slice(prefix.length) : current),
      localName,
    );
    return titleCase(withoutOwner);
  };
  if (session.type === "channel") {
    return (
      clean(session.sourceThreadName) ??
      clean(session.name) ??
      humanize(session.sourceChannel) ??
      `Channel ${shortIdentifier(session.id)}`
    );
  }
  if (session.type === "action") {
    return (
      humanize(session.triggerName) ??
      humanize(session.triggerActionName) ??
      humanize(session.agentName) ??
      `Automation ${shortIdentifier(session.id)}`
    );
  }
  if (session.type === "subagent") {
    return humanize(session.agentName) ?? `Subagent ${shortIdentifier(session.id)}`;
  }
  if (session.type === "fork") {
    return humanize(session.triggerName) ?? `Branch ${shortIdentifier(session.id)}`;
  }
  return clean(session.name) ?? `Chat ${shortIdentifier(session.id)}`;
}

function localDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour") };
}

function bucketKey(
  date: Date,
  interval: Exclude<SessionMetricsInterval, "none" | "auto">,
  timeZone: string,
) {
  const { year, month, day, hour } = localDateParts(date, timeZone);
  if (interval === "hour") return `${year}-${month}-${day}T${hour}:00`;
  const localDay = `${year}-${month}-${day}`;
  if (interval === "day") return localDay;
  const utc = new Date(`${localDay}T00:00:00.000Z`);
  const offset = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - offset);
  return utc.toISOString().slice(0, 10);
}

function effectiveInterval(
  requested: SessionMetricsInterval,
  from: Date | null,
  to: Date,
  earliest: Date | null,
): Exclude<SessionMetricsInterval, "auto"> {
  if (requested !== "auto") return requested;
  const start = from ?? earliest;
  if (!start) return "day";
  const days = Math.max(1, Math.ceil((to.getTime() - start.getTime()) / 864e5));
  if (days <= 2) return "hour";
  if (days > 90) return "week";
  return "day";
}

export class SessionQueryService {
  private readonly now: () => Date;

  constructor(private readonly options: SessionQueryServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private resolveOwner(agentName: string | null): RomeSessionOwner {
    const normalized = agentName ?? "main";
    if (normalized === "main") {
      return { type: "core", id: "core", label: "Rome", iconUrl: null };
    }
    let record: ReturnType<SessionQueryServiceOptions["agentLoader"]["getRecord"]>;
    try {
      record = this.options.agentLoader.getRecord(normalized);
    } catch {
      return { type: "unknown", id: null, label: "Uninstalled App", iconUrl: null };
    }
    if (record.metadata.ownerType === "core") {
      return { type: "core", id: "core", label: "Rome", iconUrl: null };
    }
    const app = this.options.appCatalog
      .listResolved()
      .find((candidate) => candidate.appId === record.metadata.ownerId);
    return {
      type: "app",
      id: record.metadata.ownerId,
      label: app?.displayName ?? record.metadata.ownerId,
      iconUrl: app?.iconAbsolutePath
        ? `/api/apps/${encodeURIComponent(record.metadata.ownerId)}/icon`
        : null,
    };
  }

  private resolveTime(scope: SessionQueryScope): { from: Date | null; to: Date; timeZone: string } {
    const now = this.now();
    if (scope.time.kind === "all") return { from: null, to: now, timeZone: scope.timeZone };
    if (scope.time.kind === "absolute") {
      return {
        from: new Date(scope.time.from),
        to: new Date(scope.time.to),
        timeZone: scope.timeZone,
      };
    }
    const duration =
      scope.time.value === "24h" ? 24 * 36e5 : scope.time.value === "7d" ? 7 * 864e5 : 30 * 864e5;
    return { from: new Date(now.getTime() - duration), to: now, timeZone: scope.timeZone };
  }

  private storageScope(scope: SessionQueryScope): SessionQueryStorageScope {
    const time = this.resolveTime(scope);
    const records = this.options.agentLoader.getAllResolvableRecords();
    const knownAgentNames = Array.from(new Set(["main", ...records.keys()]));
    const ownerAgentNames = new Set<string>();
    let includeUninstalledOwners = false;
    if (scope.sessions?.owners) {
      for (const owner of scope.sessions.owners) {
        if (owner.kind === "uninstalled") {
          includeUninstalledOwners = true;
          continue;
        }
        if (owner.kind === "core") ownerAgentNames.add("main");
        for (const [name, record] of records) {
          if (owner.kind === "core" && record.metadata.ownerType === "core")
            ownerAgentNames.add(name);
          if (
            owner.kind === "app" &&
            record.metadata.ownerType === "app" &&
            record.metadata.ownerId === owner.appId
          ) {
            ownerAgentNames.add(name);
          }
        }
      }
    }
    const sources = scope.sessions?.sources;
    return {
      ...time,
      sessionIds: scope.sessions?.ids,
      types: scope.sessions?.types,
      agentNames: scope.sessions?.agentNames,
      ownerAgentNames: scope.sessions?.owners ? Array.from(ownerAgentNames) : undefined,
      includeUninstalledOwners,
      knownAgentNames,
      sourceChannels: sources
        ?.filter(
          (source): source is Extract<(typeof sources)[number], { kind: "channel" }> =>
            source.kind === "channel",
        )
        .map((source) => source.channel),
      includeInternalSource: sources?.some((source) => source.kind === "internal"),
      projectPathPrefix: scope.sessions?.projectPathPrefix,
      models: scope.runs?.models?.map((model) =>
        model.kind === "unknown"
          ? { unknown: true as const }
          : { provider: model.provider, name: model.name },
      ),
      outcomes: scope.runs?.outcomes,
    };
  }

  private searchAgentNames(search?: string): string[] {
    const query = search?.trim().toLocaleLowerCase();
    if (!query) return [];
    const matches: string[] = [];
    for (const name of ["main", ...this.options.agentLoader.getAllResolvableRecords().keys()]) {
      const owner = this.resolveOwner(name);
      if (owner.label.toLocaleLowerCase().includes(query)) matches.push(name);
    }
    return matches;
  }

  private toRecord(
    session: SessionRow,
    messageCount: number,
    stats: RomeSessionStats,
    models: SessionModelIdentity[],
  ): RomeSessionExplorerRecord {
    const owner = this.resolveOwner(session.agentName);
    return {
      id: session.id,
      name: session.name,
      displayTitle: sessionDisplayTitle(session, owner),
      personaId: session.personaId,
      largeModelSelection: session.largeModelSelection,
      projectName: session.projectName,
      projectPath: session.projectPath,
      agentName: session.agentName,
      type: session.type as RomeSessionType,
      sourceChannel: session.sourceChannel,
      sourceThreadId: session.sourceThreadId,
      sourceThreadName: session.sourceThreadName,
      sourceThreadType: session.sourceThreadType,
      triggerKind: session.triggerKind,
      triggerName: session.triggerName,
      triggerActionName: session.triggerActionName,
      triggerExecutionId: session.triggerExecutionId,
      rootActionExecutionId: session.rootActionExecutionId,
      parentActionExecutionId: session.parentActionExecutionId,
      parentSessionId: session.parentSessionId,
      parentTurnId: session.parentTurnId,
      createdAt: session.createdAt.toISOString(),
      activityAt: session.activityAt.toISOString(),
      messageCount,
      owner,
      stats,
      models,
    };
  }

  async querySessions(request: SessionQueryRequest): Promise<RomeSessionsPageResult> {
    const offset = Math.max(0, request.page?.offset ?? 0);
    const limit = Math.max(1, Math.min(200, request.page?.limit ?? 50));
    const result = await this.options.repository.querySessionPage({
      scope: this.storageScope(request.scope),
      search: request.search,
      searchAgentNames: this.searchAgentNames(request.search),
      sort: {
        field: request.sort?.field ?? "activity",
        direction: request.sort?.direction ?? "desc",
      },
      offset,
      limit,
    });
    const modelRows = await this.options.repository.querySessionModels(
      this.storageScope(request.scope),
      result.rows.map((row) => row.id),
    );
    const modelsBySession = new Map<string, RawSessionModelIdentity[]>();
    for (const model of modelRows) {
      const existing = modelsBySession.get(model.sessionId) ?? [];
      existing.push(model);
      modelsBySession.set(model.sessionId, existing);
    }
    const sessions = result.rows.map((row) =>
      this.toRecord(
        row,
        row.messageCount,
        storageStats(row.stats),
        sessionModels(modelsBySession.get(row.id) ?? []),
      ),
    );
    return {
      sessions,
      total: result.total,
      offset,
      limit,
      nextOffset: offset + sessions.length < result.total ? offset + sessions.length : null,
      facets: result.facets,
    };
  }

  private dimension(run: RawSessionRunAggregate, by: SessionMetricsDimension): DimensionMetadata {
    const owner = this.resolveOwner(run.agentName);
    if (by === "app") {
      if (owner.type === "unknown") {
        return {
          key: "app:uninstalled",
          label: "Uninstalled App",
          description: "The owning App is no longer installed",
          iconUrl: null,
          kind: "unknown",
          dimension: {
            dimension: "app",
            state: "uninstalled",
            appId: null,
            label: "Uninstalled App",
            iconUrl: null,
          },
        };
      }
      const appId = owner.id ?? "core";
      return {
        key: `app:${appId}`,
        label: owner.label,
        description: owner.type === "core" ? "Core Agent" : "Agent owner",
        iconUrl: owner.iconUrl,
        kind: "named",
        dimension: {
          dimension: "app",
          state: owner.type === "core" ? "core" : "installed",
          appId,
          label: owner.label,
          iconUrl: owner.iconUrl,
        },
      };
    }
    if (by === "model") {
      if (!run.modelName) {
        return {
          key: "model:unknown",
          label: "Unknown model",
          description: "Terminal accounting unavailable",
          iconUrl: null,
          kind: "unknown",
          dimension: { dimension: "model", state: "unknown", label: "Unknown model" },
        };
      }
      return {
        key: `model:${run.modelProvider ?? "unknown"}:${run.modelName}`,
        label: run.modelName,
        description: run.modelProvider,
        iconUrl: null,
        kind: "named",
        dimension: {
          dimension: "model",
          state: "known",
          provider: run.modelProvider,
          name: run.modelName,
          label: run.modelName,
        },
      };
    }
    if (by === "type") {
      return {
        key: `type:${run.sessionType}`,
        label: sessionTypeLabel(run.sessionType),
        description: run.sessionType,
        iconUrl: null,
        kind: "named",
        dimension: {
          dimension: "type",
          value: run.sessionType,
          label: sessionTypeLabel(run.sessionType),
        },
      };
    }
    if (by === "source") {
      if (!run.sourceChannel) {
        return {
          key: "source:internal",
          label: "Internal",
          description: "Background and internal runs",
          iconUrl: null,
          kind: "named",
          dimension: {
            dimension: "source",
            state: "internal",
            channel: null,
            label: "Internal",
          },
        };
      }
      return {
        key: `source:${run.sourceChannel}`,
        label: titleCase(run.sourceChannel),
        description: "External source",
        iconUrl: null,
        kind: "named",
        dimension: {
          dimension: "source",
          state: "channel",
          channel: run.sourceChannel,
          label: titleCase(run.sourceChannel),
        },
      };
    }
    if (by === "project") {
      const label = run.projectPath ? basename(run.projectPath) || run.projectPath : "No project";
      return {
        key: `project:${run.projectPath ?? "none"}`,
        label,
        description: run.projectPath,
        iconUrl: null,
        kind: run.projectPath ? "named" : "unknown",
        dimension: { dimension: "project", path: run.projectPath, label },
      };
    }
    const name = run.agentName ?? "main";
    const localName = artifactLocalName(name);
    return {
      key: `agent:${name}`,
      label: localName === "main" ? "Main" : titleCase(localName),
      description: owner.label,
      iconUrl: owner.iconUrl,
      kind: "named",
      dimension: {
        dimension: "agent",
        name,
        label: localName === "main" ? "Main" : titleCase(localName),
      },
    };
  }

  private project(
    runs: RawSessionRunAggregate[],
    request: SessionMetricsProjectionRequest,
    scope: { from: Date | null; to: Date; timeZone: string },
  ): SessionMetricsProjection {
    const totalsByKey = new Map<
      string,
      { meta: DimensionMetadata; accumulator: MetricsAccumulator }
    >();
    const earliest = runs.reduce<Date | null>(
      (value, run) => (!value || run.createdAt < value ? run.createdAt : value),
      null,
    );
    const interval = effectiveInterval(request.interval, scope.from, scope.to, earliest);
    const bucketAccumulators = new Map<
      string,
      { total: MetricsAccumulator; groups: Map<string, MetricsAccumulator> }
    >();
    for (const run of runs) {
      const meta = this.dimension(run, request.groupBy);
      const group = totalsByKey.get(meta.key) ?? { meta, accumulator: emptyAccumulator() };
      appendAggregate(group.accumulator, run);
      totalsByKey.set(meta.key, group);
      if (interval !== "none") {
        const key = bucketKey(run.createdAt, interval, scope.timeZone);
        const bucket = bucketAccumulators.get(key) ?? {
          total: emptyAccumulator(),
          groups: new Map(),
        };
        appendAggregate(bucket.total, run);
        const value = bucket.groups.get(meta.key) ?? emptyAccumulator();
        appendAggregate(value, run);
        bucket.groups.set(meta.key, value);
        bucketAccumulators.set(key, bucket);
      }
    }

    const ordered = Array.from(totalsByKey.values()).sort(
      (left, right) =>
        metricValue(right.accumulator, request.rankBy) -
          metricValue(left.accumulator, request.rankBy) ||
        left.meta.key.localeCompare(right.meta.key),
    );
    const unknown = ordered.filter((entry) => entry.meta.kind === "unknown");
    const named = ordered.filter((entry) => entry.meta.kind !== "unknown");
    const limit = Math.max(1, Math.min(100, request.limit ?? 20));
    const selected = named.slice(0, limit);
    const tail = named.slice(limit);
    const includeOther = request.includeOther === true && tail.length > 0;
    const otherAccumulator = emptyAccumulator();
    for (const entry of tail) mergeAccumulator(otherAccumulator, entry.accumulator);
    const groupEntries: Array<{
      meta: DimensionMetadata | null;
      accumulator: MetricsAccumulator;
    }> = [
      ...selected,
      ...(includeOther ? [{ meta: null, accumulator: otherAccumulator }] : []),
      ...unknown,
    ];
    const groups: SessionMetricGroup[] = groupEntries.map(({ meta, accumulator }) => ({
      key: meta?.key ?? "other",
      label: meta?.label ?? "Other",
      description: meta ? meta.description : "Long-tail groups",
      iconUrl: meta?.iconUrl ?? null,
      kind: meta?.kind ?? "other",
      dimension: meta?.dimension ?? { dimension: "other", label: "Other" },
      sessionCount: accumulator.sessions.size,
      ...accumulatorStats(accumulator),
      lastActivityAt: (accumulator.lastActivityAt ?? scope.to).toISOString(),
    }));

    const topKeys = new Set(selected.map((entry) => entry.meta.key));
    const unknownKeys = new Set(unknown.map((entry) => entry.meta.key));
    const bucketKeys = new Set(bucketAccumulators.keys());
    if (interval !== "none") {
      const start = scope.from ?? earliest;
      if (start) {
        const step = interval === "hour" ? 36e5 : interval === "day" ? 864e5 : 7 * 864e5;
        for (let cursor = start.getTime(); cursor <= scope.to.getTime(); cursor += step) {
          bucketKeys.add(bucketKey(new Date(cursor), interval, scope.timeZone));
        }
      }
    }
    const buckets =
      interval === "none"
        ? []
        : Array.from(bucketKeys)
            .sort()
            .map((key) => {
              const bucket = bucketAccumulators.get(key) ?? {
                total: emptyAccumulator(),
                groups: new Map<string, MetricsAccumulator>(),
              };
              const values = groups.map((group) => {
                let accumulator = bucket.groups.get(group.key) ?? emptyAccumulator();
                if (group.key === "other") {
                  accumulator = emptyAccumulator();
                  for (const [groupKey, value] of bucket.groups) {
                    if (!topKeys.has(groupKey) && !unknownKeys.has(groupKey)) {
                      mergeAccumulator(accumulator, value);
                    }
                  }
                }
                return {
                  key: group.key,
                  sessionCount: accumulator.sessions.size,
                  ...accumulatorStats(accumulator),
                };
              });
              return {
                bucket: key,
                sessionCount: bucket.total.sessions.size,
                ...accumulatorStats(bucket.total),
                values,
              };
            });
    return {
      id: request.id,
      groupBy: request.groupBy,
      interval,
      rankBy: request.rankBy,
      groups,
      buckets,
    };
  }

  async queryMetrics(request: SessionMetricsRequest): Promise<SessionMetricsResponse> {
    const resolved = this.resolveTime(request.scope);
    const runs = await this.options.repository.queryRunAggregates(this.storageScope(request.scope));
    const totals = emptyAccumulator();
    for (const run of runs) appendAggregate(totals, run);
    return {
      scope: {
        from: resolved.from?.toISOString() ?? null,
        to: resolved.to.toISOString(),
        timeZone: resolved.timeZone,
      },
      totals: { sessionCount: totals.sessions.size, ...accumulatorStats(totals) },
      projections: request.projections.map((projection) =>
        this.project(runs, projection, resolved),
      ),
    };
  }

  async getSession(id: string): Promise<RomeSessionDetail | null> {
    const rows = await this.options.repository.getSessionDetailRows(id);
    if (!rows) return null;
    const allScope: SessionQueryScope = {
      time: { kind: "all" },
      timeZone: "UTC",
      sessions: { ids: [id] },
    };
    const runs = await this.options.repository.queryRunAggregates(this.storageScope(allScope));
    const models = await this.options.repository.querySessionModels(this.storageScope(allScope), [
      id,
    ]);
    const accumulator = emptyAccumulator();
    for (const run of runs) appendAggregate(accumulator, run);
    const lineageEntry = (session: SessionRow) => {
      const owner = this.resolveOwner(session.agentName);
      return {
        id: session.id,
        displayTitle: sessionDisplayTitle(session, owner),
        type: session.type as RomeSessionType,
        agentName: session.agentName,
        parentTurnId: session.parentTurnId,
        activityAt: session.activityAt.toISOString(),
      };
    };
    return {
      ...this.toRecord(
        rows.session,
        rows.messageCount,
        accumulatorStats(accumulator),
        sessionModels(models),
      ),
      lineage: {
        parent: rows.parent ? lineageEntry(rows.parent) : null,
        children: rows.children.map(lineageEntry),
      },
    };
  }
}
