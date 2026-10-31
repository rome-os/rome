import type { Account } from "@rome-os/app-runtime";
import { chatIdsOn } from "../../chats/chat-repository.js";
import { seatMessageCount } from "../../webchat/chat-read-model-sql.js";
import {
  and,
  asc,
  count,
  desc,
  eq,
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
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import type { DrizzleDb } from "../index.js";
import { romeAgentMessages, romeAgentTraceBlocks, romeSessions } from "../schema.js";
import {
  romeSessionKind,
  sessionColumns,
  sessionRowWithKind as sessionRowWithKindAndColumn,
  withSessionKind,
} from "../session-kind.js";

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

const pinnedToMain = sql`coalesce(json_type(${romeSessions.channelSettings}, '$.overrides.routing.agentName') = 'null', 0) = 1`;

/**
 * The agent that answers the row, with main as null like the stored column.
 * It mirrors `answeringAgent` in sessions/query-service.ts, the rules in
 * docs/architecture/channels.md#an-accounts-agent.
 */
function answeringAgentName(scope: SessionQueryStorageScope): SQL<string | null> {
  const links = Object.entries(scope.accountAgents ?? {});
  if (links.length === 0) return sql<string | null>`${romeSessions.agentName}`;
  const onLinkedChannel = and(
    sql`${romeSessionKind} = 'channel'`,
    inArray(
      seatChannel(scope),
      links.map(([channel]) => channel),
    ),
  );
  const accountAgent = sql`case ${seatChannel(scope)} ${sql.join(
    links.map(
      ([channel, agent]) =>
        sql`when ${channel} then ${isCoreMainAgentId(agent) ? sql`null` : agent}`,
    ),
    sql` `,
  )} end`;
  // A null routing override is an explicit pin to main.
  return sql<string | null>`case when ${onLinkedChannel} then case
    when ${romeSessions.sourceThreadType} IS 'private' then ${accountAgent}
    when ${pinnedToMain} then null
    when coalesce(${romeSessions.agentName}, 'main') in ('main', 'core:main') then ${accountAgent}
    else ${romeSessions.agentName} end else ${romeSessions.agentName} end`;
}

function normalizedAgentName(scope: SessionQueryStorageScope): SQL<string> {
  return sql<string>`coalesce(${answeringAgentName(scope)}, 'main')`;
}

const SQL_LIKE_ESCAPE = "\\";

/** One of Rome's channels and the account it is: a seat speaks through the
 *  channel that is its account on its chat's platform. */
export interface SeatChannel {
  readonly channel: string;
  readonly account: Account;
}

/**
 * The channel a session's seat speaks through, by its account and its chat's
 * platform: `webchat` for a guardian chat, null for a session with no seat
 * or whose account no channel is.
 */
function seatChannel(scope: Pick<SessionQueryStorageScope, "seatChannels">): SQL<string | null> {
  const whens = [
    sql`when ${romeSessions.chatId} in ${chatIdsOn("webchat")} then 'webchat'`,
    ...(scope.seatChannels ?? []).map(
      ({ channel, account }) =>
        sql`when ${romeSessions.accountId} = ${account.id} and ${romeSessions.chatId} in ${chatIdsOn(account.platform)} then ${channel}`,
    ),
  ];
  return sql<string | null>`(case ${sql.join(whens, sql` `)} end)`;
}

export interface SessionQueryStorageScope {
  /** Rome's channels and their accounts, which name the channel a seat
   *  speaks through. The repository fills it in. */
  seatChannels?: readonly SeatChannel[];
  from: Date | null;
  to: Date;
  sessionIds?: string[];
  types?: string[];
  agentNames?: string[];
  /** Each linked channel's agent, so agent predicates and metrics read the
   *  agent that answers a conversation rather than the stored one. */
  accountAgents?: Record<string, string>;
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
  seatChannel: string | null;
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
  const agentName = normalizedAgentName(scope);
  if (scope.sessionIds) {
    predicates.push(
      scope.sessionIds.length > 0 ? inArray(romeSessions.id, scope.sessionIds) : sql`0 = 1`,
    );
  }
  if (scope.types) {
    predicates.push(scope.types.length > 0 ? inArray(romeSessionKind, scope.types) : sql`0 = 1`);
  }
  if (scope.agentNames) {
    predicates.push(
      scope.agentNames.length > 0 ? inArray(agentName, scope.agentNames) : sql`0 = 1`,
    );
  }
  if (scope.ownerAgentNames || scope.includeUninstalledOwners) {
    const ownerPredicates: SQL[] = [];
    if (scope.ownerAgentNames?.length) {
      ownerPredicates.push(inArray(agentName, scope.ownerAgentNames));
    }
    if (scope.includeUninstalledOwners) {
      const known = scope.knownAgentNames ?? [];
      ownerPredicates.push(
        known.length > 0
          ? sql`${agentName} NOT IN (${sql.join(
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
      sourcePredicates.push(inArray(seatChannel(scope), scope.sourceChannels));
    }
    if (scope.includeInternalSource) sourcePredicates.push(isNull(seatChannel(scope)));
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
      answeringAgentName(scope),
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
      searchPredicates.push(inArray(agentName, searchAgentNames));
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
  constructor(
    private db: DrizzleDb,
    /** Rome's channels and their accounts, read per query. */
    private readonly channels: () => readonly SeatChannel[] = () => [],
  ) {}

  /** `scope` with Rome's channels, which name each seat's channel. */
  private seated<T extends SessionQueryStorageScope>(scope: T): T {
    return { ...scope, seatChannels: this.channels() };
  }

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

  async querySessionPage(unseated: SessionPageStorageQuery) {
    const query = { ...unseated, scope: this.seated(unseated.scope) };
    const runStats = this.runStats(query.scope);
    // A session's lines: its own (traces, and the text of a session in no
    // chat) plus what was said where it stands.
    const messageCounts = this.db
      .select({
        sessionId: romeSessions.id,
        count: sql<number>`(
          (SELECT count(*) FROM rome_agent_messages t WHERE t.session_id = ${romeSessions.id})
          + ${seatMessageCount}
        )`.as("message_count"),
      })
      .from(romeSessions)
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
        ...sessionColumns,
        // The seat's channel, by its account and chat, in place of the stored
        // column.
        seatChannel: seatChannel(query.scope),
        type: romeSessionKind,
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
        .select({ value: romeSessionKind, count: count() })
        .from(romeSessions)
        .innerJoin(runStats, eq(runStats.sessionId, romeSessions.id))
        .where(and(...predicates))
        .groupBy(romeSessionKind)
        .orderBy(asc(romeSessionKind)),
      this.db
        .select({ value: seatChannel(query.scope), count: count() })
        .from(romeSessions)
        .innerJoin(runStats, eq(runStats.sessionId, romeSessions.id))
        .where(and(...predicates))
        .groupBy(seatChannel(query.scope))
        .orderBy(asc(seatChannel(query.scope))),
    ]);
    return {
      rows: rows.map((row) => ({ ...row, stats: rawStats(row.stats) })),
      total: totalRows[0]?.count ?? 0,
      facets: { types: typeRows, sourceChannels: sourceRows },
    };
  }

  async queryRunAggregates(unseated: SessionQueryStorageScope): Promise<RawSessionRunAggregate[]> {
    const scope = this.seated(unseated);
    const interval = sql<number>`cast(${romeAgentMessages.createdAt} / 900 as integer)`;
    const agentName = answeringAgentName(scope);
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
        agentName,
        sessionType: romeSessionKind,
        seatChannel: seatChannel(scope),
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
        agentName,
        romeSessionKind,
        seatChannel(scope),
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
      seatChannel: row.seatChannel,
      projectPath: row.projectPath,
    }));
  }

  async getSessionDetailRows(id: string) {
    // Each row's seat's channel, by its account and chat, in place of the
    // stored column.
    const sessionRowWithKind = {
      ...sessionRowWithKindAndColumn,
      seatChannel: seatChannel({ seatChannels: this.channels() }),
    };
    const rows = await this.db
      .select(sessionRowWithKind)
      .from(romeSessions)
      .where(eq(romeSessions.id, id));
    if (!rows[0]) return null;
    const session = withSessionKind(rows[0]);
    const [messageCountRows, parentRows, childRows] = await Promise.all([
      this.db
        .select({
          count: sql<number>`(
            (SELECT count(*) FROM rome_agent_messages t WHERE t.session_id = ${id})
            + ${seatMessageCount}
          )`.mapWith(Number),
        })
        .from(romeSessions)
        .where(eq(romeSessions.id, id)),
      session.parentSessionId
        ? this.db
            .select(sessionRowWithKind)
            .from(romeSessions)
            .where(eq(romeSessions.id, session.parentSessionId))
        : Promise.resolve([]),
      this.db
        .select(sessionRowWithKind)
        .from(romeSessions)
        .where(eq(romeSessions.parentSessionId, id)),
    ]);
    return {
      session,
      messageCount: messageCountRows[0]?.count ?? 0,
      parent: parentRows[0] ? withSessionKind(parentRows[0]) : null,
      children: childRows.map(withSessionKind),
    };
  }
}
