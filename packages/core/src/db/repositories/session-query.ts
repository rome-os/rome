import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { RunOutcome, SessionsSort } from "@rome/api-types/sessions";
import type { DrizzleDb } from "../index.js";
import { romeAgentMessages, romeAgentTraceBlocks, romeSessions } from "../schema.js";

const terminalTraceBlocks = alias(romeAgentTraceBlocks, "session_query_terminal_blocks");
const turnEndTraceBlocks = alias(romeAgentTraceBlocks, "session_query_turn_end_blocks");
const terminalBlockType = sql<string>`json_extract(${terminalTraceBlocks.content}, '$.type')`;
const terminalBlockCondition = sql`${terminalBlockType} IN ('result', 'error')`;
const modelProvider = sql<
  string | null
>`nullif(trim(json_extract(${terminalTraceBlocks.content}, '$.accounting.provider')), '')`;
const modelName = sql<
  string | null
>`nullif(trim(json_extract(${terminalTraceBlocks.content}, '$.accounting.model')), '')`;
const turnEndBlockType = sql<string>`json_extract(${turnEndTraceBlocks.content}, '$.type')`;
const turnEndBlockCondition = sql`${turnEndBlockType} = 'turn_end'`;
const runStatus = sql<string | null>`json_extract(${turnEndTraceBlocks.content}, '$.status')`;
const normalizedAgentName = sql<string>`coalesce(${romeSessions.agentName}, 'main')`;
const SQL_LIKE_ESCAPE = "\\";

export interface SessionQueryStorageScope {
  from: Date | null;
  to: Date;
  sessionIds?: string[];
  types?: string[];
  agentNames?: string[];
  ownerAgentNames?: string[];
  includeUninstalledOwners?: boolean;
  knownAgentNames?: string[];
  sourceChannels?: string[];
  includeInternalSource?: boolean;
  projectPathPrefix?: string;
  models?: Array<{ provider?: string; name: string } | { unknown: true }>;
  outcomes?: RunOutcome[];
}

export interface RawSessionRunAggregate {
  sessionId: string;
  createdAt: Date;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  costedRunCount: number;
  runCount: number;
  completed: number;
  interrupted: number;
  error: number;
  unknown: number;
  modelProvider: string | null;
  modelName: string | null;
  agentName: string | null;
  sessionType: string;
  sourceChannel: string | null;
  projectPath: string | null;
}

export interface RawSessionStats {
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  costedRunCount: number;
  completed: number;
  interrupted: number;
  error: number;
  unknown: number;
}

export interface SessionPageStorageQuery {
  scope: SessionQueryStorageScope;
  search?: string;
  searchAgentNames?: string[];
  sort: { field: SessionsSort; direction: "asc" | "desc" };
  offset: number;
  limit: number;
}

function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `${SQL_LIKE_ESCAPE}${character}`);
}

function sessionPredicates(
  scope: SessionQueryStorageScope,
  search?: string,
  searchAgentNames: string[] = [],
): SQL[] {
  const predicates: SQL[] = [];
  if (scope.sessionIds) {
    predicates.push(
      scope.sessionIds.length > 0 ? inArray(romeSessions.id, scope.sessionIds) : sql`0 = 1`,
    );
  }
  if (scope.types) {
    predicates.push(scope.types.length > 0 ? inArray(romeSessions.type, scope.types) : sql`0 = 1`);
  }
  if (scope.agentNames) {
    predicates.push(
      scope.agentNames.length > 0 ? inArray(normalizedAgentName, scope.agentNames) : sql`0 = 1`,
    );
  }
  if (scope.ownerAgentNames || scope.includeUninstalledOwners) {
    const ownerPredicates: SQL[] = [];
    if (scope.ownerAgentNames?.length) {
      ownerPredicates.push(inArray(normalizedAgentName, scope.ownerAgentNames));
    }
    if (scope.includeUninstalledOwners) {
      const known = scope.knownAgentNames ?? [];
      ownerPredicates.push(
        known.length > 0
          ? sql`${normalizedAgentName} NOT IN (${sql.join(
              known.map((name) => sql`${name}`),
              sql`, `,
            )})`
          : sql`1 = 1`,
      );
    }
    predicates.push(ownerPredicates.length > 0 ? or(...ownerPredicates)! : sql`0 = 1`);
  }
  if (scope.sourceChannels || scope.includeInternalSource) {
    const sourcePredicates: SQL[] = [];
    if (scope.sourceChannels?.length) {
      sourcePredicates.push(inArray(romeSessions.sourceChannel, scope.sourceChannels));
    }
    if (scope.includeInternalSource) sourcePredicates.push(isNull(romeSessions.sourceChannel));
    predicates.push(sourcePredicates.length > 0 ? or(...sourcePredicates)! : sql`0 = 1`);
  }
  if (scope.projectPathPrefix) {
    const prefix = scope.projectPathPrefix.replace(/\/+$/, "");
    predicates.push(
      or(
        eq(romeSessions.projectPath, prefix),
        sql`${romeSessions.projectPath} LIKE ${`${escapeSqlLikePattern(prefix)}/%`} ESCAPE ${SQL_LIKE_ESCAPE}`,
      )!,
    );
  }
  const query = search?.trim();
  if (query) {
    const pattern = `%${escapeSqlLikePattern(query)}%`;
    const fields = [
      romeSessions.name,
      romeSessions.id,
      romeSessions.sourceThreadName,
      romeSessions.sourceThreadId,
      romeSessions.agentName,
      romeSessions.triggerName,
      romeSessions.triggerActionName,
      romeSessions.triggerExecutionId,
      romeSessions.projectName,
      romeSessions.projectPath,
    ];
    const searchPredicates = fields.map(
      (field) => sql`${field} LIKE ${pattern} ESCAPE ${SQL_LIKE_ESCAPE}`,
    );
    if (searchAgentNames.length > 0) {
      searchPredicates.push(inArray(normalizedAgentName, searchAgentNames));
    }
    predicates.push(or(...searchPredicates)!);
  }
  return predicates;
}

function runPredicates(scope: SessionQueryStorageScope): SQL[] {
  const predicates: SQL[] = [
    eq(romeAgentMessages.role, "trace"),
    isNotNull(romeAgentMessages.turnId),
    lte(romeAgentMessages.createdAt, scope.to),
  ];
  if (scope.from) predicates.push(gte(romeAgentMessages.createdAt, scope.from));
  if (scope.models) {
    const modelPredicates = scope.models.map((model): SQL => {
      if ("unknown" in model) return isNull(modelName);
      return model.provider
        ? and(eq(modelName, model.name), eq(modelProvider, model.provider))!
        : eq(modelName, model.name);
    });
    predicates.push(modelPredicates.length > 0 ? or(...modelPredicates)! : sql`0 = 1`);
  }
  if (scope.outcomes) {
    const outcomes = scope.outcomes.map((outcome): SQL => {
      if (outcome === "unknown") {
        return sql`${runStatus} is null or ${runStatus} not in ('completed', 'interrupted', 'error')`;
      }
      return eq(runStatus, outcome);
    });
    predicates.push(outcomes.length > 0 ? or(...outcomes)! : sql`0 = 1`);
  }
  return predicates;
}

function rawStats(row: RawSessionStats): RawSessionStats {
  return {
    runCount: Number(row.runCount),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    cacheReadTokens: Number(row.cacheReadTokens),
    cacheWriteTokens: Number(row.cacheWriteTokens),
    costUsd: row.costUsd === null ? null : Number(row.costUsd),
    costedRunCount: Number(row.costedRunCount),
    completed: Number(row.completed),
    interrupted: Number(row.interrupted),
    error: Number(row.error),
    unknown: Number(row.unknown),
  };
}

export class SessionQueryRepository {
  constructor(private db: DrizzleDb) {}

  private runStats(scope: SessionQueryStorageScope) {
    return this.db
      .select({
        sessionId: romeAgentMessages.sessionId,
        runCount: count().as("run_count"),
        inputTokens: sql<number>`coalesce(sum(${romeAgentMessages.inputTokens}), 0)`
          .mapWith(Number)
          .as("input_tokens"),
        outputTokens: sql<number>`coalesce(sum(${romeAgentMessages.outputTokens}), 0)`
          .mapWith(Number)
          .as("output_tokens"),
        cacheReadTokens: sql<number>`coalesce(sum(${romeAgentMessages.cacheReadTokens}), 0)`
          .mapWith(Number)
          .as("cache_read_tokens"),
        cacheWriteTokens: sql<number>`coalesce(sum(${romeAgentMessages.cacheWriteTokens}), 0)`
          .mapWith(Number)
          .as("cache_write_tokens"),
        costUsd: sql<number | null>`sum(${romeAgentMessages.costUsd})`.as("cost_usd"),
        costedRunCount:
          sql<number>`sum(case when ${romeAgentMessages.costUsd} is not null then 1 else 0 end)`
            .mapWith(Number)
            .as("costed_run_count"),
        completed: sql<number>`sum(case when ${runStatus} = 'completed' then 1 else 0 end)`
          .mapWith(Number)
          .as("completed_count"),
        interrupted: sql<number>`sum(case when ${runStatus} = 'interrupted' then 1 else 0 end)`
          .mapWith(Number)
          .as("interrupted_count"),
        error: sql<number>`sum(case when ${runStatus} = 'error' then 1 else 0 end)`
          .mapWith(Number)
          .as("error_count"),
        unknown:
          sql<number>`sum(case when ${runStatus} is null or ${runStatus} not in ('completed', 'interrupted', 'error') then 1 else 0 end)`
            .mapWith(Number)
            .as("unknown_count"),
      })
      .from(romeAgentMessages)
      .leftJoin(
        terminalTraceBlocks,
        and(eq(terminalTraceBlocks.messageId, romeAgentMessages.id), terminalBlockCondition),
      )
      .leftJoin(
        turnEndTraceBlocks,
        and(eq(turnEndTraceBlocks.messageId, romeAgentMessages.id), turnEndBlockCondition),
      )
      .where(and(...runPredicates(scope)))
      .groupBy(romeAgentMessages.sessionId)
      .as("session_query_run_stats");
  }

  async querySessionPage(query: SessionPageStorageQuery) {
    const runStats = this.runStats(query.scope);
    const messageCounts = this.db
      .select({ sessionId: romeAgentMessages.sessionId, count: count().as("message_count") })
      .from(romeAgentMessages)
      .groupBy(romeAgentMessages.sessionId)
      .as("session_query_message_counts");
    const predicates = [
      ...sessionPredicates(query.scope, query.search, query.searchAgentNames),
      isNotNull(runStats.sessionId),
    ];
    const sortValue =
      query.sort.field === "runs"
        ? runStats.runCount
        : query.sort.field === "tokens"
          ? sql<number>`${runStats.inputTokens} + ${runStats.outputTokens} + ${runStats.cacheReadTokens} + ${runStats.cacheWriteTokens}`
          : query.sort.field === "cost"
            ? sql<number>`coalesce(${runStats.costUsd}, -1)`
            : query.sort.field === "errors"
              ? runStats.error
              : romeSessions.activityAt;
    const primaryOrder = query.sort.direction === "asc" ? asc(sortValue) : desc(sortValue);
    const rows = await this.db
      .select({
        ...getTableColumns(romeSessions),
        messageCount: sql<number>`coalesce(${messageCounts.count}, 0)`.mapWith(Number),
        stats: {
          runCount: runStats.runCount,
          inputTokens: runStats.inputTokens,
          outputTokens: runStats.outputTokens,
          cacheReadTokens: runStats.cacheReadTokens,
          cacheWriteTokens: runStats.cacheWriteTokens,
          costUsd: runStats.costUsd,
          costedRunCount: runStats.costedRunCount,
          completed: runStats.completed,
          interrupted: runStats.interrupted,
          error: runStats.error,
          unknown: runStats.unknown,
        },
      })
      .from(romeSessions)
      .innerJoin(runStats, eq(runStats.sessionId, romeSessions.id))
      .leftJoin(messageCounts, eq(messageCounts.sessionId, romeSessions.id))
      .where(and(...predicates))
      .orderBy(primaryOrder, desc(romeSessions.createdAt), desc(romeSessions.id))
      .limit(query.limit)
      .offset(query.offset);

    const totalRows = await this.db
      .select({ count: count() })
      .from(romeSessions)
      .innerJoin(runStats, eq(runStats.sessionId, romeSessions.id))
      .where(and(...predicates));
    const [typeRows, sourceRows] = await Promise.all([
      this.db
        .select({ value: romeSessions.type, count: count() })
        .from(romeSessions)
        .innerJoin(runStats, eq(runStats.sessionId, romeSessions.id))
        .where(and(...predicates))
        .groupBy(romeSessions.type)
        .orderBy(asc(romeSessions.type)),
      this.db
        .select({ value: romeSessions.sourceChannel, count: count() })
        .from(romeSessions)
        .innerJoin(runStats, eq(runStats.sessionId, romeSessions.id))
        .where(and(...predicates))
        .groupBy(romeSessions.sourceChannel)
        .orderBy(asc(romeSessions.sourceChannel)),
    ]);
    return {
      rows: rows.map((row) => ({ ...row, stats: rawStats(row.stats) })),
      total: totalRows[0]?.count ?? 0,
      facets: { types: typeRows, sourceChannels: sourceRows },
    };
  }

  async queryRunAggregates(scope: SessionQueryStorageScope): Promise<RawSessionRunAggregate[]> {
    const interval = sql<number>`cast(${romeAgentMessages.createdAt} / 900 as integer)`;
    const rows = await this.db
      .select({
        sessionId: romeAgentMessages.sessionId,
        interval,
        lastCreatedAt: sql<number>`max(${romeAgentMessages.createdAt})`.mapWith(Number),
        inputTokens: sql<number>`coalesce(sum(${romeAgentMessages.inputTokens}), 0)`.mapWith(
          Number,
        ),
        outputTokens: sql<number>`coalesce(sum(${romeAgentMessages.outputTokens}), 0)`.mapWith(
          Number,
        ),
        cacheReadTokens:
          sql<number>`coalesce(sum(${romeAgentMessages.cacheReadTokens}), 0)`.mapWith(Number),
        cacheWriteTokens:
          sql<number>`coalesce(sum(${romeAgentMessages.cacheWriteTokens}), 0)`.mapWith(Number),
        costUsd: sql<number | null>`sum(${romeAgentMessages.costUsd})`,
        costedRunCount:
          sql<number>`sum(case when ${romeAgentMessages.costUsd} is not null then 1 else 0 end)`.mapWith(
            Number,
          ),
        runCount: count(),
        completed: sql<number>`sum(case when ${runStatus} = 'completed' then 1 else 0 end)`.mapWith(
          Number,
        ),
        interrupted:
          sql<number>`sum(case when ${runStatus} = 'interrupted' then 1 else 0 end)`.mapWith(
            Number,
          ),
        error: sql<number>`sum(case when ${runStatus} = 'error' then 1 else 0 end)`.mapWith(Number),
        unknown:
          sql<number>`sum(case when ${runStatus} is null or ${runStatus} not in ('completed', 'interrupted', 'error') then 1 else 0 end)`.mapWith(
            Number,
          ),
        modelProvider,
        modelName,
        agentName: romeSessions.agentName,
        sessionType: romeSessions.type,
        sourceChannel: romeSessions.sourceChannel,
        projectPath: romeSessions.projectPath,
      })
      .from(romeAgentMessages)
      .innerJoin(romeSessions, eq(romeSessions.id, romeAgentMessages.sessionId))
      .leftJoin(
        terminalTraceBlocks,
        and(eq(terminalTraceBlocks.messageId, romeAgentMessages.id), terminalBlockCondition),
      )
      .leftJoin(
        turnEndTraceBlocks,
        and(eq(turnEndTraceBlocks.messageId, romeAgentMessages.id), turnEndBlockCondition),
      )
      .where(and(...runPredicates(scope), ...sessionPredicates(scope)))
      .groupBy(
        romeAgentMessages.sessionId,
        interval,
        modelProvider,
        modelName,
        romeSessions.agentName,
        romeSessions.type,
        romeSessions.sourceChannel,
        romeSessions.projectPath,
      );
    return rows.map((row) => ({
      sessionId: row.sessionId,
      createdAt: new Date(row.lastCreatedAt * 1_000),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      costUsd: row.costUsd === null ? null : Number(row.costUsd),
      costedRunCount: row.costedRunCount,
      runCount: row.runCount,
      completed: row.completed,
      interrupted: row.interrupted,
      error: row.error,
      unknown: row.unknown,
      modelProvider: row.modelProvider,
      modelName: row.modelName,
      agentName: row.agentName,
      sessionType: row.sessionType,
      sourceChannel: row.sourceChannel,
      projectPath: row.projectPath,
    }));
  }

  async getSessionDetailRows(id: string) {
    const rows = await this.db.select().from(romeSessions).where(eq(romeSessions.id, id));
    const session = rows[0];
    if (!session) return null;
    const [messageCountRows, parentRows, childRows] = await Promise.all([
      this.db
        .select({ count: count() })
        .from(romeAgentMessages)
        .where(eq(romeAgentMessages.sessionId, id)),
      session.parentSessionId
        ? this.db.select().from(romeSessions).where(eq(romeSessions.id, session.parentSessionId))
        : Promise.resolve([]),
      this.db.select().from(romeSessions).where(eq(romeSessions.parentSessionId, id)),
    ]);
    return {
      session,
      messageCount: messageCountRows[0]?.count ?? 0,
      parent: parentRows[0] ?? null,
      children: childRows,
    };
  }
}
