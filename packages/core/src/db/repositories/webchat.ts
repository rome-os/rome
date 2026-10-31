import type { DeviceFolder } from "@rome/api-types/devices";
import type { TranscriptPart } from "@rome/api-types/chat";
import { createHash, randomUUID } from "node:crypto";
import { posix as pathPosix } from "node:path";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  sharedChats,
  webchatProjects,
  romeSessions,
  romeAgentMessages,
  romeAgentTraceBlocks,
  webchatTurnFeedback,
  webchatWorkspaceLayouts,
} from "../schema.js";
import type { DrizzleDb } from "../index.js";
import {
  channelChatId,
  isWebchatChat,
  romeSessionKind,
  storedSessionType,
  withSessionKind,
} from "../session-kind.js";
import { DEFAULT_WEBCHAT_PROJECT_NAME } from "../../webchat/constants.js";
import {
  isSessionTraceArchived,
  sessionTraceCutoff,
  TRACE_ACTIVITY_ROLES,
} from "../../webchat/trace-retention.js";
import type {
  TraceSubagentResultEvent,
  TraceSubagentStartEvent,
  TurnFeedbackRating,
} from "@rome/api-types/trace-segments";
import type { Account, ChatId, RecentChat, RomeSessionType } from "@rome-os/app-runtime";
import { chatKey, ownedBy, placeIn, type Place } from "../../chats/place.js";
import { ChatIds } from "../../channels/chat-ids.js";
import { TurnLinks, type ContextLine } from "../../sessions/turn-links.js";
import { ChatRepository } from "../../chats/chat-repository.js";
import { MessageRepository } from "../../chats/message-repository.js";
import { partsText, type SaidBy } from "../../chats/message.js";
import type { MessagePart } from "../../types.js";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import { stripHostOnlyPartsFromContent } from "../../channels/host-only-parts.js";
import { sessionOwnerKey, type SessionActor } from "../../lib/session-actor.js";

export interface StoredTurnFeedback {
  rating: TurnFeedbackRating;
  comment: string | null;
  updatedAt: Date;
}

export interface StoredWebchatMessage {
  id: string;
  sessionId: string;
  turnId: string | null;
  inputState?: import("@rome-os/app-runtime").AgentInputState | null;
  role: string;
  content: string;
  platformMessageId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  replyToPlatformMessageId?: string | null;
  contextInjectedTurnId?: string | null;
  createdAt: Date;
}

export interface StoredConversationContextMessage {
  id: string;
  content: string;
  senderName: string | null;
  createdAt: Date;
}

/** A said message's row, as {@link WebChatRepository.saidMessagesAt} reads
 *  it, with the channel of the chat row that holds it. */
/** One of Rome's seats in a place: the session an account's agent stands
 *  in it through. */
export interface Seat {
  readonly sessionId: string;
  readonly place: Place;
  /** The account the seat speaks as, on the place's platform. */
  readonly accountId: string;
  /** The agent that speaks through the seat. */
  readonly agent: string;
  /** The channel the seat's account speaks through. */
  readonly channel: string;
}

export interface StoredSaidMessage {
  id: string;
  channel: string;
  turnId: string | null;
  role: string;
  content: string;
  platformMessageId: string | null;
  senderId: string | null;
  senderName: string | null;
  replyToPlatformMessageId: string | null;
  createdAt: Date;
}

export interface StoredSharedChat {
  id: string;
  sessionId: string;
  title: string;
  snapshot: string;
  layout: string;
  projectPath: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface StoredSharedChatSummary {
  id: string;
  title: string;
  createdAt: Date;
}

export interface StoredWebchatHistoryMessage extends StoredWebchatMessage {
  sessionName: string;
  sessionAgentName: string | null;
}

export interface StoredWebchatProject {
  archivedAt: Date | null;
  createdAt: Date;
  id: string;
  name: string;
  path: string;
  updatedAt: Date;
}

export interface StoredWebchatSessionRef {
  agentName: string | null;
  id: string;
  type: string;
  largeModelSelection: string | null;
  projectPath: string | null;
}

interface TraceAccountingTotals {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  hasAccounting: boolean;
  hasCost: boolean;
}

interface ProjectSessionCursor {
  activityAt: number;
  createdAt: number;
  id: string;
}

interface ProjectUsageDayRange {
  date: string;
  end: Date;
  start: Date;
}

interface ProjectUsageTotalsOptions {
  dayRanges?: ProjectUsageDayRange[];
  dayStart?: Date;
  monthStart: Date;
}

interface ProviderUsageAmounts {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

const UNKNOWN_USAGE_PROVIDER = "unknown";

function providerUsageAmountsSql(condition = sql`1`) {
  const sum = (path: string) =>
    sql`COALESCE(SUM(CASE WHEN ${condition} AND json_type(block, ${path}) IN ('integer', 'real') THEN json_extract(block, ${path}) ELSE 0 END), 0)`;
  return {
    cacheReadTokens: sum("$.accounting.usage.cacheReadTokens"),
    cacheWriteTokens: sum("$.accounting.usage.cacheWriteTokens"),
    costUsd: sum("$.accounting.costUsd"),
    inputTokens: sum("$.accounting.usage.inputTokens"),
    outputTokens: sum("$.accounting.usage.outputTokens"),
  };
}

function readProviderUsageAmounts(
  row: Record<string, unknown>,
  prefix: string,
): ProviderUsageAmounts {
  return {
    cacheReadTokens: Number(row[`${prefix}CacheReadTokens`] ?? 0),
    cacheWriteTokens: Number(row[`${prefix}CacheWriteTokens`] ?? 0),
    costUsd: Number(row[`${prefix}CostUsd`] ?? 0),
    inputTokens: Number(row[`${prefix}InputTokens`] ?? 0),
    outputTokens: Number(row[`${prefix}OutputTokens`] ?? 0),
  };
}

/**
 * Every terminal block carrying accounting, with its trace row's `created_at`
 * for bucketing. A trace's stored accounting columns are summed from these
 * same blocks, so per-provider sums reconcile with the row totals while still
 * splitting a turn that ran on more than one provider. Block-store traces read
 * through the terminal-block partial index; legacy traces still hold their
 * blocks inline, and `mergeTraceContent` ignores that copy once block rows
 * exist. `rowFilter` sees `session_id` and `created_at` unambiguously.
 */
function terminalAccountingBlocksSql(rowFilter: SQL) {
  return sql`
    SELECT m.created_at AS created_at, terminal.content AS block
    FROM rome_agent_messages m
    JOIN (
      SELECT message_id, content
      FROM rome_agent_trace_blocks
      WHERE json_extract(content, '$.type') IN ('result', 'error')
    ) terminal ON terminal.message_id = m.id
    WHERE m.role = 'trace'
      ${rowFilter}
    UNION ALL
    SELECT m.created_at AS created_at, inline_block.value AS block
    FROM rome_agent_messages m, json_each(m.content) inline_block
    WHERE m.role = 'trace'
      AND m.content <> '[]'
      AND json_valid(m.content)
      AND json_type(m.content) = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM rome_agent_trace_blocks stored WHERE stored.message_id = m.id
      )
      AND json_extract(inline_block.value, '$.type') IN ('result', 'error')
      ${rowFilter}
  `;
}

const terminalBlockProviderSql = sql`COALESCE(NULLIF(TRIM(json_extract(block, '$.accounting.provider')), ''), ${UNKNOWN_USAGE_PROVIDER})`;

function usageDayRangeSql(dayRanges: ProjectUsageDayRange[]) {
  const dateCase = sql`CASE ${sql.join(
    dayRanges.map(
      (range) =>
        sql`WHEN created_at >= ${Math.floor(range.start.getTime() / 1000)}
            AND created_at < ${Math.floor(range.end.getTime() / 1000)}
            THEN ${range.date}`,
    ),
    sql.raw(" "),
  )} END`;
  const dateFilter = sql.join(
    dayRanges.map(
      (range) =>
        sql`(created_at >= ${Math.floor(range.start.getTime() / 1000)}
            AND created_at < ${Math.floor(range.end.getTime() / 1000)})`,
    ),
    sql.raw(" OR "),
  );
  return { dateCase, dateFilter };
}

export interface AddTurnRecapMessageInput {
  sessionId: string;
  turnId: string;
  content: string;
  audioUrl?: string;
  audioMimeType?: string;
  audioDurationMs?: number;
}

export interface EnsureRomeSessionInput {
  id: string;
  type: RomeSessionType;
  name: string;
  agentName: string | null;
  projectName?: string;
  projectPath?: string | null;
  /** A side chat keeps the folder of the chat it branched from. */
  deviceFolder?: DeviceFolder | null;
  sourceChannel?: string | null;
  sourceThreadId?: string | null;
  sourceThreadName?: string | null;
  sourceThreadType?: "private" | "group" | string | null;
  trigger?: RomeAgentTraceTriggerMetadata;
  /** Lineage for 'fork' sessions: the rome session the fork branched from. */
  parentSessionId?: string | null;
  /** The turn on the parent session that triggered the fork. */
  parentTurnId?: string | null;
}

export interface RomeAgentTraceTriggerMetadata {
  triggerKind?: string | null;
  triggerName?: string | null;
  triggerActionName?: string | null;
  triggerExecutionId?: string | null;
  rootActionExecutionId?: string | null;
  parentActionExecutionId?: string | null;
}

export interface RomeAgentTranscriptMessageInput {
  id: string;
  sessionId: string;
  turnId: string | null;
  role: "user" | "assistant";
  content: string;
}

export type WebchatMessageInsertedListener = (message: StoredWebchatMessage) => void;
export type WebchatSessionNameChangedListener = (event: {
  sessionId: string;
  name: string;
}) => void;

interface TraceReadOptions {
  /** Dashboard reads hide all traces in sessions whose last message is at or before this cutoff. */
  sessionActivityCutoff?: Date;
  /** Reads only these trace messages (stub and blocks). Other traces of the session stay unread. */
  messageIds?: readonly string[];
}

/** Where a message page ends: the oldest turn group (or lone message) it holds. */
export interface MessagePageCursor {
  /** `created_at` (epoch seconds) of the group's earliest row. */
  startedAt: number;
  /** The group's `turn_id`, or the row id for a message without a turn. */
  key: string;
}

export interface MessagePageOptions {
  /** Turn groups per page. Rows without a turn each count as one group. */
  limit: number;
  /** Return only groups strictly older than this cursor. */
  before?: MessagePageCursor | null;
}

function traceReadFields(archivedSessionIds: string[]) {
  const archived = archivedSessionIds.length
    ? sql<boolean>`${romeAgentMessages.role} = 'trace' AND ${inArray(romeAgentMessages.sessionId, archivedSessionIds)}`.mapWith(
        Boolean,
      )
    : sql<boolean>`0`.mapWith(Boolean);
  return {
    id: romeAgentMessages.id,
    traceArchived: archived,
    content: sql<string>`CASE WHEN ${archived} THEN '[]' ELSE ${romeAgentMessages.content} END`,
  };
}

function traceContentResult(row: { id: string; content: string; traceArchived: boolean }) {
  return {
    id: row.id,
    content: row.content,
    ...(row.traceArchived ? { traceArchived: true } : {}),
  };
}

const webchatMessageSelectFields = {
  id: romeAgentMessages.id,
  sessionId: romeAgentMessages.sessionId,
  turnId: romeAgentMessages.turnId,
  role: romeAgentMessages.role,
  content: romeAgentMessages.content,
  createdAt: romeAgentMessages.createdAt,
};

// How many lines the session's transcript holds: its chat's messages plus its
// own traces.
const sessionLineCount = sql<number>`(
  (select count(*) from "chat_messages" m
   where m."chat_id" = "rome_sessions"."chat_id" and m."thread_id" is "rome_sessions"."thread_id")
  + (select count(*) from "rome_agent_messages" t
     where t."session_id" = "rome_sessions"."id" and t."role" = 'trace')
)`.mapWith(Number);
const sessionSelectFields = {
  id: romeSessions.id,
  name: romeSessions.name,
  personaId: romeSessions.personaId,
  largeModelSelection: romeSessions.largeModelSelection,
  projectName: romeSessions.projectName,
  projectPath: romeSessions.projectPath,
  // The sidebar groups a device-folder chat under its folder, not its project.
  deviceFolder: romeSessions.deviceFolder,
  agentName: romeSessions.agentName,
  triggerKind: romeSessions.triggerKind,
  archivedAt: romeSessions.archivedAt,
  pinnedAt: romeSessions.pinnedAt,
  createdAt: romeSessions.createdAt,
  activityAt: sql<number>`cast(${romeSessions.activityAt} as integer)`.mapWith(Number),
  lastSeenActivityAt: romeSessions.lastSeenActivityAt,
  unread:
    sql<boolean>`case when ${romeSessions.lastSeenActivityAt} is not null and ${romeSessions.activityAt} > ${romeSessions.lastSeenActivityAt} then 1 else 0 end`.mapWith(
      Boolean,
    ),
  messageCount: sessionLineCount,
};

const sessionActivityAt = sql<number>`cast(${romeSessions.activityAt} as integer)`;

// Whether the session's latest turn ended in an error, read from the
// `turn_end` block of its newest trace. A turn still running has no
// `turn_end` yet and a stopped turn ends `interrupted`, so neither counts.
// `created_at` has one-second precision, so rowid (insertion order) breaks
// ties between turns that start in the same second.
export const sessionLastTurnFailed = sql<boolean>`coalesce((
  select json_extract(b."content", '$.status') = 'error'
  from "rome_agent_trace_blocks" b
  where b."message_id" = (
    select m."id" from "rome_agent_messages" m
    where m."session_id" = "rome_sessions"."id" and m."role" = 'trace'
    order by m."created_at" desc, m."rowid" desc
    limit 1
  )
  and json_extract(b."content", '$.type') = 'turn_end'
  order by b."seq" desc
  limit 1
), 0)`.mapWith(Boolean);
// Whether the session's chat waits on the guardian: a card (question,
// connect-AI, app component) in a line from Rome after the guardian's last
// line, or an approval still pending in this chat. Any answer to a card is
// saved as the guardian's line, so a card after the last one is still open.
// rowid is insertion order, and `idx_chat_messages_place` makes "after the
// last" a range. Every reply adds an auto-approved row to `approvals`, so the
// pending thread ids are collected once per list rather than scanned per chat.
// json_valid and the object check skip rows that aren't block arrays
// (non-JSON, or legacy plain text), which would otherwise fail the whole list.
export const sessionAwaitingGuardian = sql<boolean>`(exists (
  select 1 from "chat_messages" m, json_each(m."parts") part
  where m."chat_id" = "rome_sessions"."chat_id" and m."thread_id" is "rome_sessions"."thread_id"
  and m."sender_agent" is not null and json_valid(m."parts")
  and m."rowid" > coalesce((
    select max(u."rowid") from "chat_messages" u
    where u."chat_id" = "rome_sessions"."chat_id" and u."thread_id" is "rome_sessions"."thread_id"
    and u."sender_agent" is null
    and exists (select 1 from "agent_turn_messages" ul where ul."message_id" = u."id" and ul."role" = 'prompt')
  ), 0)
  and case when part."type" = 'object' then json_extract(part."value", '$.type') end = 'pending_interaction'
) or "rome_sessions"."id" in (
  select json_extract(a."payload", '$.channelContext.threadId') from "approvals" a
  where a."status" = 'pending'
  and json_extract(a."payload", '$.channelContext.threadId') is not null
))`.mapWith(Boolean);
const SESSION_DELETE_CHUNK_SIZE = 500;
const SQL_LIKE_ESCAPE = "\\";

export { channelChatId };

/** The row id a recorded outbound message takes when the provider named it.
 *  Derived rather than random so a caller that knows the provider's id can
 *  predict the timeline `ref` the message will carry. */
export function conversationPlatformMessageId(
  sessionId: string,
  platformMessageId: string,
): string {
  const digest = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(platformMessageId)
    .digest("hex");
  return `channel-message:${digest}`;
}

function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `${SQL_LIKE_ESCAPE}${character}`);
}

function projectPathChildCondition(
  column: typeof webchatProjects.path | typeof romeSessions.projectPath,
  projectPath: string,
) {
  return sql`${column} LIKE ${`${escapeSqlLikePattern(projectPath)}/%`} ESCAPE ${SQL_LIKE_ESCAPE}`;
}

function projectPathPrefixCondition(projectPath: string) {
  return sql`(
    ${romeSessions.projectPath} = ${projectPath}
    OR ${projectPathChildCondition(romeSessions.projectPath, projectPath)}
  )`;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function parseNumeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyTraceAccountingTotals(): TraceAccountingTotals {
  return {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    hasAccounting: false,
    hasCost: false,
  };
}

function accumulateBlockAccounting(totals: TraceAccountingTotals, block: unknown): void {
  if (!block || typeof block !== "object") return;
  const type = (block as { type?: unknown }).type;
  if (type !== "result" && type !== "error") return;
  const accounting = (block as { accounting?: unknown }).accounting;
  if (!accounting || typeof accounting !== "object") return;
  totals.hasAccounting = true;
  const usage = (accounting as { usage?: unknown }).usage;
  if (usage && typeof usage === "object") {
    totals.cacheReadTokens += parseNumeric(
      (usage as { cacheReadTokens?: unknown }).cacheReadTokens,
    );
    totals.cacheWriteTokens += parseNumeric(
      (usage as { cacheWriteTokens?: unknown }).cacheWriteTokens,
    );
    totals.inputTokens += parseNumeric((usage as { inputTokens?: unknown }).inputTokens);
    totals.outputTokens += parseNumeric((usage as { outputTokens?: unknown }).outputTokens);
  }
  const costUsd = (accounting as { costUsd?: unknown }).costUsd;
  if (typeof costUsd === "number" && Number.isFinite(costUsd)) {
    totals.hasCost = true;
    totals.costUsd += costUsd;
  }
}

function extractTraceAccountingTotals(content: string): TraceAccountingTotals {
  const totals = emptyTraceAccountingTotals();

  let blocks: unknown;
  try {
    blocks = JSON.parse(content);
  } catch {
    return totals;
  }

  if (!Array.isArray(blocks)) return totals;

  for (const block of blocks) {
    accumulateBlockAccounting(totals, block);
  }

  return totals;
}

/**
 * Reassemble the legacy JSON-array trace content from append-only block rows.
 * Block rows store one serialized block each, so the merge is pure string
 * concatenation — no parse of previously persisted blocks. When a trace has
 * no block rows (persisted before `rome_agent_trace_blocks` existed) the stub
 * content — the full legacy array — is returned untouched.
 */
function mergeTraceContent(stubContent: string, blockContents: string[]): string {
  if (blockContents.length === 0) return stubContent;
  return `[${blockContents.join(",")}]`;
}

/** Max rows per INSERT batch, keeping bound parameters well under SQLite limits. */
const TRACE_BLOCK_INSERT_CHUNK = 200;
export const INTERRUPTED_TURN_ERROR =
  "Rome restarted while this was running. The task did not finish.";

function traceAccountingColumns(role: string, content: string): TraceAccountingTotals | null {
  if (role !== "trace") return null;
  const totals = extractTraceAccountingTotals(content);
  return totals.hasAccounting ? totals : null;
}

function isAllowedProjectAssetPathname(pathname: string): boolean {
  const matchesRoute = (basePath: string) => {
    if (pathname === basePath) return true;
    if (!pathname.startsWith(`${basePath}/`)) return false;
    const fileName = pathname.slice(basePath.length + 1);
    return fileName.length > 0 && !fileName.includes("/");
  };
  return matchesRoute("/projects/asset") || matchesRoute("/api/projects/asset");
}

function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

export function validateTurnRecapAudioUrl(audioUrl: string): string {
  if (audioUrl.length === 0 || audioUrl.trim() !== audioUrl) {
    throw new Error("Recap audioUrl must be a non-empty relative URL");
  }
  if (!audioUrl.startsWith("/")) {
    throw new Error("Recap audioUrl must be root-relative");
  }
  if (audioUrl.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(audioUrl)) {
    throw new Error("Recap audioUrl must not be absolute or protocol-prefixed");
  }
  if (audioUrl.includes("\\")) {
    throw new Error("Recap audioUrl must not contain backslashes");
  }

  let parsed: URL;
  try {
    parsed = new URL(audioUrl, "http://rome.local");
  } catch {
    throw new Error("Recap audioUrl is not a valid URL");
  }

  const decodedPathname = decodePathname(parsed.pathname);
  if (decodedPathname.includes("\\")) {
    throw new Error("Recap audioUrl pathname must not contain backslashes");
  }
  if (!isAllowedProjectAssetPathname(decodedPathname)) {
    throw new Error("Recap audioUrl must use the projects asset route");
  }

  const logicalPath = parsed.searchParams.get("path");
  if (!logicalPath) {
    throw new Error("Recap audioUrl must include a path query parameter");
  }
  if (
    logicalPath.includes("\\") ||
    logicalPath.startsWith("/") ||
    logicalPath.startsWith("//") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(logicalPath)
  ) {
    throw new Error("Recap audioUrl path must be a relative projects logical path");
  }

  const segments = logicalPath.split("/");
  if (
    segments.length < 2 ||
    segments[0] !== "projects" ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    pathPosix.normalize(logicalPath) !== logicalPath
  ) {
    throw new Error("Recap audioUrl path must stay inside the projects logical root");
  }

  return audioUrl;
}

function isVisibleChatRole(role: string): boolean {
  return role === "user" || role === "assistant" || role === "notification";
}

function advanceSessionActivitySet(createdAt: Date) {
  const timestamp = Math.floor(createdAt.getTime() / 1000);
  return {
    activityAt: sql<Date>`case when ${romeSessions.activityAt} < ${timestamp} then ${timestamp} else ${romeSessions.activityAt} end`,
  };
}

function encodeProjectSessionCursor(row: {
  activityAt: number;
  createdAt: Date;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      activityAt: row.activityAt,
      createdAt: Math.floor(row.createdAt.getTime() / 1000),
      id: row.id,
    } satisfies ProjectSessionCursor),
    "utf8",
  ).toString("base64url");
}

function decodeProjectSessionCursor(cursor: string | undefined): ProjectSessionCursor | null {
  if (!cursor) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<ProjectSessionCursor>;
    if (
      typeof parsed.activityAt === "number" &&
      Number.isFinite(parsed.activityAt) &&
      typeof parsed.createdAt === "number" &&
      Number.isFinite(parsed.createdAt) &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0
    ) {
      return {
        activityAt: parsed.activityAt,
        createdAt: parsed.createdAt,
        id: parsed.id,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export class WebChatRepository {
  private messageInsertedListeners = new Set<WebchatMessageInsertedListener>();
  private sessionNameChangedListeners = new Set<WebchatSessionNameChangedListener>();

  /** Chats, where a dashboard chat starts and its lines are said. */
  private readonly chats: ChatRepository;
  private readonly lines: MessageRepository;
  private readonly links: TurnLinks;

  constructor(private db: DrizzleDb) {
    this.chats = new ChatRepository(db);
    this.lines = new MessageRepository(db);
    this.links = new TurnLinks(db);
  }

  /**
   * Start the dashboard chat session `sessionId` stands in: a direct message
   * between the guardian and the agent's dashboard account, keyed by an
   * opaque id given now. Changes nothing for a session that already has one.
   */
  private startDashboardChat(sessionId: string, name: string, agentName: string | null): void {
    const row = this.db
      .select({ chatId: romeSessions.chatId })
      .from(romeSessions)
      .where(eq(romeSessions.id, sessionId))
      .get();
    if (!row || row.chatId) return;
    // The dashboard is its own adapter and gives its chats random ids.
    const chat = this.chats.start(
      { platform: WEBCHAT_PLATFORM, id: randomUUID().replaceAll("-", "") },
      "dm",
      name,
    );
    this.db
      .update(romeSessions)
      .set({ chatId: chat.ref.id, accountId: dashboardAccountId(agentName) })
      .where(eq(romeSessions.id, sessionId))
      .run();
  }

  onMessageInserted(listener: WebchatMessageInsertedListener): () => void {
    this.messageInsertedListeners.add(listener);
    return () => {
      this.messageInsertedListeners.delete(listener);
    };
  }

  private emitMessageInserted(message: StoredWebchatMessage): void {
    for (const listener of this.messageInsertedListeners) {
      listener(message);
    }
  }

  onSessionNameChanged(listener: WebchatSessionNameChangedListener): () => void {
    this.sessionNameChangedListeners.add(listener);
    return () => {
      this.sessionNameChangedListeners.delete(listener);
    };
  }

  private emitSessionNameChanged(sessionId: string, name: string): void {
    for (const listener of this.sessionNameChangedListeners) {
      listener({ sessionId, name });
    }
  }

  async createProject(
    name: string,
    projectPath: string,
    options: { id?: string; now?: Date } = {},
  ): Promise<StoredWebchatProject> {
    const now = options.now ?? new Date();
    const rows = await this.db
      .insert(webchatProjects)
      .values({
        id: options.id ?? randomUUID(),
        name,
        path: projectPath,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      })
      .returning();
    if (!rows[0]) throw new Error("Failed to create webchat project");
    return rows[0];
  }

  async ensureProject(
    projectPath: string,
    name: string,
    options: { id?: string; now?: Date } = {},
  ): Promise<StoredWebchatProject> {
    const now = options.now ?? new Date();
    const rows = await this.db
      .insert(webchatProjects)
      .values({
        id: options.id ?? randomUUID(),
        name,
        path: projectPath,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      })
      .onConflictDoUpdate({
        target: webchatProjects.path,
        set: {
          name,
          updatedAt: now,
          archivedAt: null,
        },
      })
      .returning();
    if (!rows[0]) throw new Error("Failed to ensure webchat project");
    return rows[0];
  }

  async getProjectByPath(projectPath: string): Promise<StoredWebchatProject | null> {
    const rows = await this.db
      .select()
      .from(webchatProjects)
      .where(and(eq(webchatProjects.path, projectPath), isNull(webchatProjects.archivedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async getProjectRecordByPath(projectPath: string): Promise<StoredWebchatProject | null> {
    const rows = await this.db
      .select()
      .from(webchatProjects)
      .where(eq(webchatProjects.path, projectPath))
      .limit(1);
    return rows[0] ?? null;
  }

  async archiveProjectsByPathPrefix(
    projectPath: string,
    options: { now?: Date } = {},
  ): Promise<string[]> {
    const now = options.now ?? new Date();
    const rows = await this.db
      .update(webchatProjects)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          isNull(webchatProjects.archivedAt),
          sql`(${webchatProjects.path} = ${projectPath} OR ${projectPathChildCondition(webchatProjects.path, projectPath)})`,
        ),
      )
      .returning({ path: webchatProjects.path });
    return rows.map((row) => row.path);
  }

  async unarchiveProjectsByPaths(
    projectPaths: string[],
    options: { now?: Date } = {},
  ): Promise<void> {
    if (projectPaths.length === 0) return;
    const now = options.now ?? new Date();
    await this.db
      .update(webchatProjects)
      .set({ archivedAt: null, updatedAt: now })
      .where(inArray(webchatProjects.path, projectPaths));
  }

  async deleteArchivedProjectsByPathPrefix(projectPath: string): Promise<number> {
    const rows = await this.db
      .delete(webchatProjects)
      .where(
        and(
          sql`(${webchatProjects.path} = ${projectPath} OR ${projectPathChildCondition(webchatProjects.path, projectPath)})`,
          isNotNull(webchatProjects.archivedAt),
        ),
      )
      .returning({ path: webchatProjects.path });
    return rows.length;
  }

  async listSessionRefsByProjectPathPrefix(
    projectPath: string,
  ): Promise<StoredWebchatSessionRef[]> {
    return this.db
      .select({
        agentName: romeSessions.agentName,
        id: romeSessions.id,
        type: romeSessionKind,
        largeModelSelection: romeSessions.largeModelSelection,
        projectPath: romeSessions.projectPath,
      })
      .from(romeSessions)
      .where(projectPathPrefixCondition(projectPath))
      .orderBy(asc(romeSessions.createdAt), asc(romeSessions.id));
  }

  async deleteSessionsByProjectPathPrefix(projectPath: string): Promise<number> {
    // The id read belongs in the same transaction as the deletes it drives.
    // Reading first and awaiting leaves a window where a session created for
    // the project lands after the list is taken: it isn't in the id list, so
    // it survives the delete and is left pointing at a project that no longer
    // exists. `.all()` is the synchronous terminal the better-sqlite3
    // transaction scope requires (the same shape the deletes' `.run()` uses).
    return this.db.transaction((tx) => {
      const sessionIds = tx
        .select({ id: romeSessions.id })
        .from(romeSessions)
        .where(projectPathPrefixCondition(projectPath))
        .orderBy(asc(romeSessions.createdAt), asc(romeSessions.id))
        .all()
        .map((row) => row.id);
      if (sessionIds.length === 0) return 0;

      // Same persistence contract as deleteSession(), but batched for project
      // deletion and all session kinds (top-level chats plus handoff children).
      for (const chunk of chunkArray(sessionIds, SESSION_DELETE_CHUNK_SIZE)) {
        tx.delete(romeAgentTraceBlocks).where(inArray(romeAgentTraceBlocks.sessionId, chunk)).run();
        tx.delete(romeAgentMessages).where(inArray(romeAgentMessages.sessionId, chunk)).run();
        tx.delete(webchatTurnFeedback).where(inArray(webchatTurnFeedback.sessionId, chunk)).run();
        tx.delete(webchatWorkspaceLayouts)
          .where(inArray(webchatWorkspaceLayouts.sessionId, chunk))
          .run();
        tx.delete(sharedChats).where(inArray(sharedChats.sessionId, chunk)).run();
        tx.run(sql`
          DELETE FROM chats WHERE platform = ${WEBCHAT_PLATFORM} AND id IN (
            SELECT chat_id FROM rome_sessions
            WHERE id IN (SELECT value FROM json_each(${JSON.stringify(chunk)})))
        `);
        tx.delete(romeSessions).where(inArray(romeSessions.id, chunk)).run();
      }

      return sessionIds.length;
    });
  }

  async listProjects(): Promise<StoredWebchatProject[]> {
    return this.db
      .select()
      .from(webchatProjects)
      .where(isNull(webchatProjects.archivedAt))
      .orderBy(
        sql`CASE WHEN ${webchatProjects.path} = ${DEFAULT_WEBCHAT_PROJECT_NAME} THEN 0 ELSE 1 END`,
        asc(webchatProjects.path),
      );
  }

  async createSession(
    id: string,
    name: string,
    personaId?: string,
    projectName: string = DEFAULT_WEBCHAT_PROJECT_NAME,
    largeModelSelection?: string | null,
    projectPath: string | null = projectName,
    agentName: string | null = null,
    // 'webchat_handoff' mints a handoff sub-conversation that stays out of the
    // sidebar; the default 'webchat' covers every top-level guardian chat.
    type: "webchat" | "webchat_handoff" = "webchat",
    // JSON handback contract for a 'webchat_handoff' session (see schema comment).
    handoffSpec: string | null = null,
    ownership: { ownerKey?: string | null; inheritOwnerFrom?: string } = {},
    // Set only here: a chat's device folder never changes after creation.
    deviceFolder: DeviceFolder | null = null,
  ) {
    const now = new Date();
    if (projectPath?.trim()) {
      await this.ensureProject(projectPath, projectName);
    }

    await this.db.insert(romeSessions).values({
      id,
      ownerKey:
        ownership.ownerKey !== undefined
          ? ownership.ownerKey
          : await this.getSessionOwnerKey(ownership.inheritOwnerFrom),
      name,
      personaId: personaId ?? null,
      projectName,
      projectPath,
      deviceFolder,
      largeModelSelection: largeModelSelection ?? null,
      agentName,
      type: storedSessionType(type),
      sourceChannel: "webchat",
      sourceThreadId: id,
      sourceThreadName: name,
      sourceThreadType: "private",
      handoffSpec,
      createdAt: now,
      activityAt: now,
      lastSeenActivityAt: type === "webchat" ? now : null,
    });
    this.startDashboardChat(id, name, agentName);
  }

  async ensureRomeSession(input: EnsureRomeSessionInput): Promise<void> {
    const now = new Date();
    // A chat is a channel row on the webchat channel, at its own address,
    // whichever of the two types the caller names it by.
    const chat =
      input.type === "webchat" || (input.type === "channel" && input.sourceChannel === "webchat");
    await this.db
      .insert(romeSessions)
      .values({
        id: input.id,
        ownerKey: await this.getSessionOwnerKey(input.parentSessionId),
        name: input.name,
        personaId: null,
        projectName: input.projectName ?? DEFAULT_WEBCHAT_PROJECT_NAME,
        projectPath: input.projectPath ?? null,
        deviceFolder: input.deviceFolder ?? null,
        largeModelSelection: null,
        agentName: input.agentName,
        type: storedSessionType(input.type),
        sourceChannel: chat ? "webchat" : (input.sourceChannel ?? null),
        sourceThreadId: chat ? input.id : (input.sourceThreadId ?? null),
        sourceThreadName: input.sourceThreadName ?? null,
        sourceThreadType: input.sourceThreadType ?? null,
        triggerKind: input.trigger?.triggerKind ?? null,
        triggerName: input.trigger?.triggerName ?? null,
        triggerActionName: input.trigger?.triggerActionName ?? null,
        triggerExecutionId: input.trigger?.triggerExecutionId ?? null,
        rootActionExecutionId: input.trigger?.rootActionExecutionId ?? null,
        parentActionExecutionId: input.trigger?.parentActionExecutionId ?? null,
        parentSessionId: input.parentSessionId ?? null,
        parentTurnId: input.parentTurnId ?? null,
        handoffSpec: null,
        createdAt: now,
        activityAt: now,
        lastSeenActivityAt: chat ? now : null,
      })
      .onConflictDoNothing({ target: romeSessions.id });
    if (chat) this.startDashboardChat(input.id, input.name, input.agentName);
  }

  /**
   * The seat of Rome's account `accountId` at a channel address: the session
   * through which its agent stands in chat `chatId`, or in the thread
   * `threadId` names under `parentThreadId`. Opened on first use, with the
   * parent chat's seat for a thread. Finding a seat needs only the address;
   * opening one throws without `chatId` and `accountId`.
   */
  async ensureChannelChat(input: {
    channel: string;
    threadId: string;
    parentThreadId?: string;
    threadName?: string;
    threadType?: "private" | "group";
    agentName: string;
    projectName?: string;
    projectPath?: string;
    chatId?: string;
    accountId?: string;
  }): Promise<{ id: string; agentName: string | null }> {
    const parent =
      input.parentThreadId && input.parentThreadId !== input.threadId
        ? await this.ensureChannelChat({
            ...input,
            threadId: input.parentThreadId,
            parentThreadId: undefined,
            threadName: undefined,
            threadType: "group",
          })
        : null;
    const found = await this.findChannelConversation(input.channel, input.threadId);
    if (found && input.threadName) {
      await this.backfillChannelConversationName(found, input, input.threadName);
    }
    const existing = found && { id: found.id, agentName: found.agentName };
    if (existing) {
      if (!parent) return existing;
      // A native thread has its own model session but not its own routing
      // policy. Keep the derived row in sync with the parent on admission.
      await this.db
        .update(romeSessions)
        .set({ parentSessionId: parent.id, agentName: parent.agentName })
        .where(eq(romeSessions.id, existing.id));
      return { ...existing, agentName: parent.agentName };
    }
    // Only the dashboard opens a chat, through `createSession`. A webchat
    // address that names no chat is a deleted chat or a handoff, not a new one.
    if (input.channel === "webchat") {
      throw new Error(`No chat at webchat address ${input.threadId}`);
    }

    if (input.chatId === undefined || input.accountId === undefined) {
      throw new Error(
        `No seat at ${input.channel}:${input.threadId}, and no chat named to open one in`,
      );
    }
    const id = channelChatId(input.channel, input.threadId);
    const now = new Date();
    await this.db
      .insert(romeSessions)
      .values({
        id,
        name: input.threadName ?? `${input.channel}:${input.threadId}`,
        personaId: null,
        projectName: input.projectName ?? DEFAULT_WEBCHAT_PROJECT_NAME,
        projectPath: input.projectPath ?? null,
        largeModelSelection: null,
        agentName: parent
          ? parent.agentName
          : isCoreMainAgentId(input.agentName)
            ? null
            : input.agentName,
        type: "channel",
        sourceChannel: input.channel,
        sourceThreadId: input.threadId,
        sourceThreadName: input.threadName ?? null,
        sourceThreadType: input.threadType ?? null,
        parentSessionId: parent?.id ?? null,
        chatId: input.chatId,
        threadId: parent ? input.threadId : null,
        accountId: input.accountId,
        createdAt: now,
        activityAt: now,
        lastSeenActivityAt: null,
      })
      .onConflictDoNothing();

    const conversation = await this.findChannelConversation(input.channel, input.threadId);
    if (!conversation) {
      throw new Error(`Failed to resolve conversation ${input.channel}:${input.threadId}`);
    }
    return { id: conversation.id, agentName: conversation.agentName };
  }

  /**
   * Where session `sessionId` stands as one of Rome's seats: the place, the
   * account it speaks as, its agent and the channel it speaks through. Null
   * for a session that stands in no chat, such as a subagent or a fork.
   */
  async seatOf(sessionId: string): Promise<Seat | null> {
    const row = this.db.all<{
      platform: string;
      chat_id: string;
      thread_id: string | null;
      account_id: string | null;
      agent_name: string | null;
      source_channel: string | null;
    }>(sql`
      SELECT c.platform, c.id AS chat_id, s.thread_id, s.account_id, s.agent_name,
             s.source_channel
      FROM rome_sessions s JOIN chats c ON c.id = s.chat_id
      WHERE s.id = ${sessionId}
    `)[0];
    if (!row) return null;
    return {
      sessionId,
      place: placeIn(
        { platform: row.platform, id: row.chat_id },
        row.thread_id === null ? undefined : (row.thread_id as ChatId),
      ),
      accountId: row.account_id ?? row.source_channel ?? row.platform,
      agent: row.agent_name ?? "main",
      channel: row.source_channel ?? row.platform,
    };
  }

  /** The session that stands in the dashboard chat keyed `key`, or null
   *  when Rome holds no dashboard chat there. */
  async dashboardSessionAt(key: string): Promise<string | null> {
    return (
      this.db.all<{ id: string }>(sql`
        SELECT s.id FROM chats c JOIN rome_sessions s ON s.chat_id = c.id
        WHERE c.platform = ${WEBCHAT_PLATFORM} AND c.id = ${key}
        ORDER BY s.created_at LIMIT 1
      `)[0]?.id ?? null
    );
  }

  /** The message said where session `sessionId` stands whose platform id is
   *  `platformMessageId`, as the platform gave it, or null when none is. */
  async seatMessageId(sessionId: string, platformMessageId: string): Promise<string | null> {
    return (await this.seatLine(sessionId, platformMessageId))?.id ?? null;
  }

  /** The line said in session `sessionId`'s chat, in any of its threads,
   *  whose platform id is `platformMessageId` as the platform gave it, or null
   *  when Rome holds none. */
  async seatLine(sessionId: string, platformMessageId: string): Promise<ContextLine | null> {
    const seat = await this.seatOf(sessionId);
    if (!seat) return null;
    const owned = ownedBy(ChatIds.key(seat.place.chat), seat.accountId, platformMessageId);
    const row = this.db.all<{
      id: string;
      sender_name: string | null;
      text: string;
      said_at: number;
    }>(sql`
      SELECT m.id,
        CASE WHEN m.sender_agent IS NOT NULL THEN coalesce(m.sender_name, 'Rome')
             ELSE m.sender_name END AS sender_name,
        m.text, m.said_at
      FROM rome_sessions s
      JOIN chat_messages m ON m.chat_id = s.chat_id AND m.id = ${ChatIds.message(seat.place.chat, owned)}
      WHERE s.id = ${sessionId}
    `)[0];
    return row
      ? {
          id: row.id,
          senderName: row.sender_name,
          text: row.text,
          at: new Date(row.said_at * 1000),
        }
      : null;
  }

  /** Move session `sessionId`'s activity to `at` when `at` is later, as
   *  something said where it stands does. */
  async advanceActivity(sessionId: string, at: Date): Promise<void> {
    await this.db
      .update(romeSessions)
      .set(advanceSessionActivitySet(at))
      .where(eq(romeSessions.id, sessionId));
  }

  /** Turn `turnId` of session `sessionId` runs for its prompt, the message
   *  whose platform id is `platformMessageId`. Changes nothing when no such
   *  message is its prompt. */
  async assignConversationMessageTurn(
    sessionId: string,
    platformMessageId: string,
    turnId: string,
  ): Promise<void> {
    const id = await this.seatMessageId(sessionId, platformMessageId);
    if (id) this.links.promptRuns(sessionId, id, turnId);
  }

  /** Fill in a conversation's name when the row holds only its address, as
   *  rows created before the channel reported a name do. A name already
   *  recorded is kept, so email subjects and guardian renames stay put. */
  private async backfillChannelConversationName(
    row: { id: string; name: string; sourceThreadName: string | null },
    address: { channel: string; threadId: string },
    threadName: string,
  ): Promise<void> {
    const placeholders = [address.threadId, `${address.channel}:${address.threadId}`];
    const sourceMissing =
      row.sourceThreadName === null || placeholders.includes(row.sourceThreadName);
    const nameMissing = placeholders.includes(row.name);
    if (!sourceMissing && !nameMissing) return;
    // Each column is rewritten only while it still holds a placeholder, so a
    // concurrent message that already filled it in leaves nothing to change.
    const updated = await this.db
      .update(romeSessions)
      .set({
        sourceThreadName: sql`case when ${romeSessions.sourceThreadName} is null or ${inArray(romeSessions.sourceThreadName, placeholders)} then ${threadName} else ${romeSessions.sourceThreadName} end`,
        name: sql`case when ${inArray(romeSessions.name, placeholders)} then ${threadName} else ${romeSessions.name} end`,
      })
      .where(
        and(
          eq(romeSessions.id, row.id),
          or(
            isNull(romeSessions.sourceThreadName),
            inArray(romeSessions.sourceThreadName, placeholders),
            inArray(romeSessions.name, placeholders),
          ),
        ),
      )
      .returning({ name: romeSessions.name });
    if (nameMissing && updated[0]?.name === threadName) {
      this.emitSessionNameChanged(row.id, threadName);
    }
  }

  private async findChannelConversation(
    channel: string,
    threadId: string,
  ): Promise<{
    id: string;
    agentName: string | null;
    name: string;
    sourceThreadName: string | null;
  } | null> {
    const rows = await this.db
      .select({
        id: romeSessions.id,
        agentName: romeSessions.agentName,
        name: romeSessions.name,
        sourceThreadName: romeSessions.sourceThreadName,
      })
      .from(romeSessions)
      .where(
        and(
          eq(romeSessions.type, "channel"),
          eq(romeSessions.sourceChannel, channel),
          eq(romeSessions.sourceThreadId, threadId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The id of the conversation a channel address names, or null when none
   *  exists yet. A webchat conversation's address is its own id. Forks and
   *  subagent runs copy their parent's address, so only conversation types
   *  match. */
  async findChatIdByAddress(channel: string, threadId: string): Promise<string | null> {
    const rows = await this.db
      .select({ id: romeSessions.id })
      .from(romeSessions)
      .where(
        and(
          inArray(romeSessions.type, ["webchat_handoff", "channel"]),
          eq(romeSessions.sourceChannel, channel),
          eq(romeSessions.sourceThreadId, threadId),
        ),
      )
      .orderBy(asc(romeSessions.createdAt), asc(romeSessions.id))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async deleteSession(id: string) {
    // A dashboard chat is its session's alone, so it ends with it. A channel
    // chat goes on without the seat.
    const seat = await this.seatOf(id);
    if (seat && seat.place.chat.platform === WEBCHAT_PLATFORM) this.chats.end(seat.place.chat);
    // One transaction so a crash mid-cascade can't leave orphan messages or
    // feedback rows behind. `webchat_turn_feedback` also cascades via its FK,
    // but we still issue the explicit delete so the contract holds even if a
    // future migration drops the constraint. `await` matters here: on the
    // better-sqlite3 driver `transaction()` is synchronous and `await`
    // resolves on the same tick, but the postgres adapter returns a real
    // Promise — dropping the await would silently turn this into a fire-
    // and-forget delete.
    await this.db.transaction((tx) => {
      tx.delete(romeAgentTraceBlocks).where(eq(romeAgentTraceBlocks.sessionId, id)).run();
      tx.delete(romeAgentMessages).where(eq(romeAgentMessages.sessionId, id)).run();
      tx.delete(webchatTurnFeedback).where(eq(webchatTurnFeedback.sessionId, id)).run();
      tx.delete(webchatWorkspaceLayouts).where(eq(webchatWorkspaceLayouts.sessionId, id)).run();
      // Kill the chat's public shares too. They're keyed by sessionId and only
      // discoverable via listSharedChatsBySession, so leaving them behind would
      // strand live, unrevokable links once the source chat is gone. Deleting
      // the chat must take its public copies with it.
      tx.delete(sharedChats).where(eq(sharedChats.sessionId, id)).run();
      tx.delete(romeSessions).where(eq(romeSessions.id, id)).run();
    });
  }

  async getSessionOwnerKey(sessionId?: string | null): Promise<string | null> {
    if (!sessionId) return null;
    const [row] = await this.db
      .select({ ownerKey: romeSessions.ownerKey })
      .from(romeSessions)
      .where(eq(romeSessions.id, sessionId))
      .limit(1);
    return row?.ownerKey ?? null;
  }

  /** Attributes a person-created fork and its opening input without changing agent context. */
  async attributePersonFork(sessionId: string, turnId: string, actor: SessionActor | undefined) {
    await this.db.transaction((tx) => {
      tx.update(romeSessions)
        .set({ ownerKey: sessionOwnerKey(actor) })
        .where(eq(romeSessions.id, sessionId))
        .run();
      tx.update(romeAgentMessages)
        .set({ actor: actor ?? null })
        .where(
          and(
            eq(romeAgentMessages.sessionId, sessionId),
            eq(romeAgentMessages.turnId, turnId),
            eq(romeAgentMessages.role, "user"),
          ),
        )
        .run();
    });
  }

  /** Omit ownerKey to list all owners. NULL matches none, and the guardian includes NULL-owned sessions. */
  async listSessions(status: "active" | "archived" | "all" = "active", ownerKey?: string | null) {
    // Only top-level guardian chats. Handoff child sessions are reached through
    // their parent's handoff card, not the sidebar. `status` filters on the
    // reversible archive flag: "active" (default, preserves prior behavior)
    // shows only un-archived chats, "archived" only archived, "all" both.
    const archivePredicate =
      status === "active"
        ? isNull(romeSessions.archivedAt)
        : status === "archived"
          ? isNotNull(romeSessions.archivedAt)
          : undefined;
    return this.db
      .select({
        ...sessionSelectFields,
        lastTurnFailed: sessionLastTurnFailed,
        awaitingGuardian: sessionAwaitingGuardian,
      })
      .from(romeSessions)
      .where(
        and(
          isWebchatChat,
          archivePredicate,
          ownerKey === undefined
            ? undefined
            : ownerKey === null
              ? sql`0`
              : ownerKey === "guardian"
                ? or(eq(romeSessions.ownerKey, ownerKey), isNull(romeSessions.ownerKey))
                : eq(romeSessions.ownerKey, ownerKey),
        ),
      )
      .orderBy(desc(romeSessions.activityAt), desc(romeSessions.createdAt), desc(romeSessions.id));
  }

  async archiveSession(id: string, options: { now?: Date } = {}) {
    // Scoped to top-level webchat rows: no other session type ever carries the
    // archive flag, so the type guard lives in the WHERE.
    const now = options.now ?? new Date();
    await this.db
      .update(romeSessions)
      .set({ archivedAt: now })
      .where(and(eq(romeSessions.id, id), isWebchatChat));
  }

  async unarchiveSession(id: string, _options: { now?: Date } = {}) {
    await this.db
      .update(romeSessions)
      .set({ archivedAt: null })
      .where(and(eq(romeSessions.id, id), isWebchatChat));
  }

  async pinSession(id: string, options: { now?: Date } = {}) {
    const now = options.now ?? new Date();
    await this.db
      .update(romeSessions)
      .set({ pinnedAt: now })
      .where(and(eq(romeSessions.id, id), isWebchatChat));
  }

  async unpinSession(id: string) {
    await this.db
      .update(romeSessions)
      .set({ pinnedAt: null })
      .where(and(eq(romeSessions.id, id), isWebchatChat));
  }

  async listProjectPaths() {
    const rows = await this.listProjects();
    return rows.map((row) => row.path);
  }

  async listSessionsByProjectPath(
    projectPath: string,
    options: { cursor?: string; limit?: number } = {},
  ) {
    const limit = Math.max(1, options.limit ?? 50);
    const cursor = decodeProjectSessionCursor(options.cursor);
    const cursorPredicate = cursor
      ? sql`(
          ${sessionActivityAt} < ${cursor.activityAt}
          OR (
            ${sessionActivityAt} = ${cursor.activityAt}
            AND (
              ${romeSessions.createdAt} < ${cursor.createdAt}
              OR (
                ${romeSessions.createdAt} = ${cursor.createdAt}
                AND ${romeSessions.id} < ${cursor.id}
              )
            )
          )
        )`
      : undefined;
    const predicates = [eq(romeSessions.projectPath, projectPath), isWebchatChat, cursorPredicate];

    const rows = await this.db
      .select(sessionSelectFields)
      .from(romeSessions)
      .where(and(...predicates))
      .orderBy(desc(romeSessions.activityAt), desc(romeSessions.createdAt), desc(romeSessions.id))
      .limit(limit + 1);

    const sessions = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit && sessions.length > 0
        ? encodeProjectSessionCursor(sessions[sessions.length - 1])
        : null;
    const countRows = await this.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(romeSessions)
      .where(and(eq(romeSessions.projectPath, projectPath), isWebchatChat));

    return {
      nextCursor,
      sessions,
      total: countRows[0]?.count ?? 0,
    };
  }

  async listSessionsPage(options: { cursor?: string; limit?: number } = {}) {
    const limit = Math.max(1, options.limit ?? 50);
    const cursor = decodeProjectSessionCursor(options.cursor);
    const cursorPredicate = cursor
      ? sql`(
          ${sessionActivityAt} < ${cursor.activityAt}
          OR (
            ${sessionActivityAt} = ${cursor.activityAt}
            AND (
              ${romeSessions.createdAt} < ${cursor.createdAt}
              OR (
                ${romeSessions.createdAt} = ${cursor.createdAt}
                AND ${romeSessions.id} < ${cursor.id}
              )
            )
          )
        )`
      : undefined;
    const predicates = [isWebchatChat, cursorPredicate];

    const rows = await this.db
      .select(sessionSelectFields)
      .from(romeSessions)
      .where(and(...predicates))
      .orderBy(desc(romeSessions.activityAt), desc(romeSessions.createdAt), desc(romeSessions.id))
      .limit(limit + 1);

    const sessions = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit && sessions.length > 0
        ? encodeProjectSessionCursor(sessions[sessions.length - 1])
        : null;
    const countRows = await this.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(romeSessions)
      .where(isWebchatChat);

    return {
      nextCursor,
      sessions,
      total: countRows[0]?.count ?? 0,
    };
  }

  /** The listed dashboard chats among `ids`, as the sidebar reads them, by id. */
  async listSessionsByIds(ids: string[]) {
    if (ids.length === 0)
      return new Map<string, Awaited<ReturnType<typeof this.listSessions>>[number]>();
    const rows = await this.db
      .select({
        ...sessionSelectFields,
        lastTurnFailed: sessionLastTurnFailed,
        awaitingGuardian: sessionAwaitingGuardian,
      })
      .from(romeSessions)
      .where(and(isWebchatChat, inArray(romeSessions.id, ids)));
    return new Map(rows.map((row) => [row.id, row]));
  }

  async getSession(id: string) {
    const rows = await this.db.select().from(romeSessions).where(eq(romeSessions.id, id));
    return rows[0] ? withSessionKind(rows[0]) : null;
  }

  async markSessionRead(id: string) {
    const rows = await this.db
      .update(romeSessions)
      .set({ lastSeenActivityAt: sql`${romeSessions.activityAt}` })
      .where(eq(romeSessions.id, id))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Promote fork `id` to a dashboard chat: it starts a chat of its own, its
   * user and assistant lines are said there as the fork said them, each
   * linked to the turn it took or gave, and it answers at its own address. A
   * session that is not a fork, as after a delete racing this, is a no-op.
   */
  async promoteForkToChat(id: string): Promise<void> {
    const fork = this.db
      .select({ name: romeSessions.name, agentName: romeSessions.agentName })
      .from(romeSessions)
      .where(and(eq(romeSessions.id, id), eq(romeSessions.type, "fork")))
      .get();
    if (!fork) return;
    await this.db
      .update(romeSessions)
      .set({
        type: storedSessionType("webchat"),
        // A fork carries its parent's address. As a chat it answers at its own.
        sourceChannel: "webchat",
        sourceThreadId: sql`${romeSessions.id}`,
        lastSeenActivityAt: sql`${romeSessions.activityAt}`,
      })
      .where(and(eq(romeSessions.id, id), eq(romeSessions.type, "fork")));
    this.startDashboardChat(id, fork.name, fork.agentName);
    const seat = await this.seatOf(id);
    if (!seat) return;
    const said = this.db
      .select({
        id: romeAgentMessages.id,
        turnId: romeAgentMessages.turnId,
        role: romeAgentMessages.role,
        content: romeAgentMessages.content,
        actor: romeAgentMessages.actor,
        createdAt: romeAgentMessages.createdAt,
      })
      .from(romeAgentMessages)
      .where(
        and(
          eq(romeAgentMessages.sessionId, id),
          inArray(romeAgentMessages.role, ["user", "assistant"]),
        ),
      )
      .orderBy(asc(romeAgentMessages.createdAt), sql`${romeAgentMessages}.rowid`)
      .all();
    for (const line of said) {
      const parts = partsOf(line.content);
      const fromAgent = line.role === "assistant";
      const sender = fromAgent
        ? { account: { platform: WEBCHAT_PLATFORM, id: seat.accountId }, agent: seat.agent }
        : dashboardSender(line.actor ?? undefined);
      await this.lines.record({
        direction: "toRome",
        id: line.id,
        place: seat.place,
        saidBy: sender,
        body: { text: partsText(parts) },
        parts,
        at: line.createdAt,
      });
      if (line.turnId === null) continue;
      if (fromAgent) this.links.answer(line.id, id, line.turnId);
      else this.links.prompt(line.id, id, line.turnId);
    }
    this.db
      .delete(romeAgentMessages)
      .where(
        and(
          eq(romeAgentMessages.sessionId, id),
          inArray(romeAgentMessages.role, ["user", "assistant"]),
        ),
      )
      .run();
  }

  /** Marks why a chat exists. Read by the sessions explorer and the chat list. */
  async setSessionTrigger(
    id: string,
    trigger: { triggerKind: string; triggerName: string | null },
  ): Promise<void> {
    await this.db
      .update(romeSessions)
      .set({ triggerKind: trigger.triggerKind, triggerName: trigger.triggerName })
      .where(eq(romeSessions.id, id));
  }

  async updateSessionName(id: string, name: string) {
    const rows = await this.db
      .update(romeSessions)
      .set({ name })
      .where(eq(romeSessions.id, id))
      .returning({ id: romeSessions.id });
    if (rows.length > 0) this.emitSessionNameChanged(id, name);
  }

  async updateSessionNameIfCurrent(id: string, currentName: string, name: string) {
    const rows = await this.db
      .update(romeSessions)
      .set({ name })
      .where(and(eq(romeSessions.id, id), eq(romeSessions.name, currentName)))
      .returning({ id: romeSessions.id });
    const renamed = rows.length > 0;
    if (renamed) this.emitSessionNameChanged(id, name);
    return renamed;
  }

  async updateSessionProject(
    id: string,
    projectName: string,
    projectPath: string | null = projectName,
  ) {
    if (projectPath?.trim()) {
      await this.ensureProject(projectPath, projectName);
    }

    await this.db
      .update(romeSessions)
      .set({ projectName, projectPath })
      .where(eq(romeSessions.id, id));
  }

  async updateSessionLargeModelSelection(id: string, largeModelSelection: string | null) {
    await this.db.update(romeSessions).set({ largeModelSelection }).where(eq(romeSessions.id, id));
  }

  /** How many lines session `sessionId`'s transcript holds. */
  async getMessageCount(sessionId: string) {
    const rows = this.db.all<{ count: number }>(
      sql`SELECT count(*) AS count FROM ${sessionLines([sessionId])}`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Record a dashboard input, said into the session's chat and queued as its
   * prompt. `saidBy` is the agent account that said it when an agent, not the
   * guardian, sends into the chat. False when `id` is already on record.
   */
  async recordUserInput(
    id: string,
    sessionId: string,
    content: string,
    actor?: SessionActor,
    saidBy?: Account,
  ): Promise<boolean> {
    const seat = await this.seatOf(sessionId);
    if (!seat) throw new Error(`Session ${sessionId} stands in no chat to say an input in`);
    const parts = partsOf(content);
    const recorded = await this.lines.record({
      direction: "toRome",
      id,
      place: seat.place,
      saidBy: saidBy ? { account: saidBy } : dashboardSender(actor),
      body: { text: partsText(parts) },
      parts,
      at: new Date(),
    });
    if (!recorded) return false;
    this.links.prompt(id, sessionId, null, "queued");
    await this.advanceActivity(sessionId, recorded.at);
    return true;
  }

  async recoverInterruptedInputs(): Promise<void> {
    // A process crash can occur between the durable dispatch marker and the
    // provider acknowledgement. Preserve the message without replaying it.
    this.links.forgetInputsInFlight();
  }

  /**
   * End the turns a stopped Rome process left open. A crash writes no
   * `turn_end`, so the turn would look unfinished forever. Each trace started
   * within `windowMs` of the newest trace whose last `turn_start` has no later
   * `turn_end` gets an `error` block and a `turn_end` with status `error`.
   * Before them, each `subagent_start` in that turn with no `subagent_result`
   * gets a `subagent_result` with status `failed` and the same error, since no
   * process is left to finish that subagent.
   * Counting from the newest trace, not from now, keeps the stopped process's
   * turns in range however long Rome was down. Older traces stay as they are.
   * Returns how many turns it ended.
   */
  async endInterruptedTurns(windowMs: number): Promise<number> {
    const newest = await this.db
      .select({ createdAt: sql<number | null>`max(${romeAgentMessages.createdAt})` })
      .from(romeAgentMessages)
      .where(eq(romeAgentMessages.role, "trace"))
      .get();
    if (newest?.createdAt == null) return 0;
    // `created_at` is stored in seconds.
    const since = new Date(newest.createdAt * 1000 - windowMs);
    const blockSeq = (type: string) => sql<number | null>`(
      select max(b."seq") from "rome_agent_trace_blocks" b
      where b."message_id" = ${romeAgentMessages.id}
        and json_extract(b."content", '$.type') = ${type}
    )`;
    const traces = await this.db
      .select({
        id: romeAgentMessages.id,
        sessionId: romeAgentMessages.sessionId,
        turnId: romeAgentMessages.turnId,
        lastStart: blockSeq("turn_start"),
        lastEnd: blockSeq("turn_end"),
        lastSeq: sql<number>`(
          select max(b."seq") from "rome_agent_trace_blocks" b
          where b."message_id" = ${romeAgentMessages.id}
        )`,
      })
      .from(romeAgentMessages)
      .where(and(eq(romeAgentMessages.role, "trace"), gte(romeAgentMessages.createdAt, since)));

    let ended = 0;
    for (const trace of traces) {
      if (trace.lastStart === null || (trace.lastEnd !== null && trace.lastEnd > trace.lastStart)) {
        continue;
      }
      const start = await this.db
        .select({ content: romeAgentTraceBlocks.content })
        .from(romeAgentTraceBlocks)
        .where(
          and(
            eq(romeAgentTraceBlocks.messageId, trace.id),
            eq(romeAgentTraceBlocks.seq, trace.lastStart),
          ),
        )
        .get();
      const turnStart = start
        ? (JSON.parse(start.content) as { turnId?: string; agent?: string })
        : {};
      const agent = turnStart.agent ? { agent: turnStart.agent } : {};
      const delegations = await this.db
        .select({ content: romeAgentTraceBlocks.content })
        .from(romeAgentTraceBlocks)
        .where(
          and(
            eq(romeAgentTraceBlocks.messageId, trace.id),
            gt(romeAgentTraceBlocks.seq, trace.lastStart),
            inArray(sql`json_extract(${romeAgentTraceBlocks.content}, '$.type')`, [
              "subagent_start",
              "subagent_result",
            ]),
          ),
        )
        .orderBy(asc(romeAgentTraceBlocks.seq));
      const running = new Map<string, TraceSubagentStartEvent>();
      for (const row of delegations) {
        const block = JSON.parse(row.content) as TraceSubagentStartEvent | TraceSubagentResultEvent;
        if (block.type === "subagent_start") running.set(block.toolUseId, block);
        else running.delete(block.toolUseId);
      }
      // No `endedAt`: the subagent's real end is unknown, and now would count the downtime.
      const subagentEnds: TraceSubagentResultEvent[] = [...running.values()].map((call) => ({
        type: "subagent_result",
        toolUseId: call.toolUseId,
        agentName: call.agentName,
        sessionId: call.sessionId,
        turnId: call.turnId,
        status: "failed",
        error: { message: INTERRUPTED_TURN_ERROR },
        ...(call.agent ? { agent: call.agent } : {}),
      }));
      await this.appendTraceBlocks({
        messageId: trace.id,
        sessionId: trace.sessionId,
        turnId: trace.turnId,
        startSeq: trace.lastSeq + 1,
        blocks: [
          ...subagentEnds,
          { type: "error", error: INTERRUPTED_TURN_ERROR, ...agent },
          {
            type: "turn_end",
            turnId: turnStart.turnId ?? trace.turnId,
            status: "error",
            // The turn's real duration is unknown; elapsed time would count the downtime.
            durationMs: 0,
            ...agent,
          },
        ],
      });
      ended += 1;
    }
    return ended;
  }

  async getUserInput(sessionId: string, inputId: string) {
    const link = this.links.linkOf(sessionId, inputId);
    return link?.role === "prompt"
      ? { turnId: link.turnId, inputState: link.inputState }
      : undefined;
  }

  async updateUserInput(
    sessionId: string,
    status: import("@rome-os/app-runtime").InputStatusEvent,
  ): Promise<void> {
    this.links.promptRuns(sessionId, status.inputId, status.turnId ?? null, status.state);
  }

  /**
   * Add a line to session `sessionId`'s transcript. A user or assistant line
   * of a session that stands in a chat is said there: the guardian's, or the
   * agent's answer to `turnId`. Every other line, and every line of a session
   * that stands in no chat, stays the session's own.
   */
  async addMessage(
    id: string,
    sessionId: string,
    role: string,
    content: string,
    turnId: string | null = null,
  ) {
    const seat = role === "user" || role === "assistant" ? await this.seatOf(sessionId) : null;
    if (seat) {
      await this.say(seat, id, role as "user" | "assistant", partsOf(content), turnId);
      return;
    }
    const accounting = traceAccountingColumns(role, content);
    await this.db.transaction((tx) => {
      const createdAt = new Date();
      tx.insert(romeAgentMessages)
        .values({
          id,
          sessionId,
          turnId,
          role,
          content,
          cacheReadTokens: accounting?.hasAccounting ? accounting.cacheReadTokens : null,
          cacheWriteTokens: accounting?.hasAccounting ? accounting.cacheWriteTokens : null,
          costUsd: accounting?.hasCost ? accounting.costUsd : null,
          inputTokens: accounting?.hasAccounting ? accounting.inputTokens : null,
          outputTokens: accounting?.hasAccounting ? accounting.outputTokens : null,
          createdAt,
        })
        .run();
      if (isVisibleChatRole(role)) {
        tx.update(romeSessions)
          .set(advanceSessionActivitySet(createdAt))
          .where(eq(romeSessions.id, sessionId))
          .run();
      }
    });
  }

  /** Say a dashboard line where `seat` stands, linked to `turnId`. Rome is
   *  the platform, so the line is delivered once it is recorded. */
  private async say(
    seat: Seat,
    id: string,
    role: "user" | "assistant",
    parts: MessagePart[],
    turnId: string | null,
  ): Promise<Date> {
    const at = new Date();
    if (role === "user") {
      await this.lines.record({
        direction: "toRome",
        id,
        place: seat.place,
        saidBy: dashboardSender(undefined),
        body: { text: partsText(parts) },
        parts,
        at,
      });
      if (turnId) this.links.prompt(id, seat.sessionId, turnId);
    } else {
      const sent = await this.lines.send(
        {
          direction: "fromRome",
          place: seat.place,
          saidBy: {
            account: { platform: WEBCHAT_PLATFORM, id: seat.accountId },
            agent: seat.agent,
          },
          parts,
        },
        // The dashboard adapter names its line, and the client knows it by
        // that id already.
        async () => ({ id }),
      );
      if (sent.id && turnId) this.links.answer(sent.id, seat.sessionId, turnId);
    }
    await this.advanceActivity(seat.sessionId, at);
    return at;
  }

  /**
   * Persist a backend-initiated message and notify subscribers.
   *
   * Backend-initiated messages (turn recaps, approval-continuation replies,
   * any agent output produced outside a foreground user turn) have no
   * per-turn SSE stream the browser is attached to, so the `message_inserted`
   * push is the only path by which the session view learns the row exists.
   * User-initiated turns deliberately do NOT notify on insert, which is why
   * `addMessage` stays silent and this is separate.
   */
  private async insertBackendMessage(
    sessionId: string,
    turnId: string | null,
    role: "assistant",
    parts: TranscriptPart[],
    id: string = randomUUID(),
  ): Promise<StoredWebchatMessage> {
    const seat = await this.seatOf(sessionId);
    if (!seat) throw new Error(`Session ${sessionId} stands in no chat to say a message in`);
    const createdAt = await this.say(seat, id, role, parts as MessagePart[], turnId);
    const message: StoredWebchatMessage = {
      id,
      sessionId,
      turnId,
      role,
      content: JSON.stringify(parts),
      createdAt: new Date(Math.floor(createdAt.getTime() / 1000) * 1000),
    };
    this.emitMessageInserted(message);
    return message;
  }

  /**
   * Persist an assistant message a channel sends into a chat and notify
   * subscribers, like {@link insertBackendMessage}.
   */
  async addSentMessage(
    id: string,
    sessionId: string,
    parts: MessagePart[],
    turnId: string | null,
  ): Promise<void> {
    await this.insertBackendMessage(sessionId, turnId, "assistant", parts, id);
  }

  async addTurnRecapMessage(input: AddTurnRecapMessageInput): Promise<StoredWebchatMessage> {
    const content = input.content.trim();
    if (!content) {
      throw new Error("Recap content is required");
    }
    if (!(await this.hasTurnInSession(input.sessionId, input.turnId))) {
      throw new Error("Turn not found in session");
    }

    const audioUrl =
      input.audioUrl !== undefined ? validateTurnRecapAudioUrl(input.audioUrl) : undefined;
    if (input.audioMimeType !== undefined) {
      if (!/^audio\/[-+.\w]+$/i.test(input.audioMimeType)) {
        throw new Error("Recap audioMimeType must be an audio MIME type");
      }
    }
    if (input.audioDurationMs !== undefined) {
      if (
        !Number.isFinite(input.audioDurationMs) ||
        input.audioDurationMs < 0 ||
        !Number.isInteger(input.audioDurationMs)
      ) {
        throw new Error("Recap audioDurationMs must be a non-negative integer");
      }
    }
    const part: Extract<MessagePart, { type: "turn_recap" }> = {
      type: "turn_recap",
      turnId: input.turnId,
      content,
      ...(audioUrl !== undefined ? { audioUrl } : {}),
      ...(input.audioMimeType !== undefined ? { audioMimeType: input.audioMimeType } : {}),
      ...(input.audioDurationMs !== undefined ? { audioDurationMs: input.audioDurationMs } : {}),
    };

    return this.insertBackendMessage(input.sessionId, input.turnId, "assistant", [part]);
  }

  /**
   * Persist an agent reply produced by a backend-initiated turn (e.g. an
   * approval continuation) as an ordinary assistant chat bubble. See
   * {@link insertBackendMessage} for why backend messages push live.
   */
  async addBackendReplyMessage(
    sessionId: string,
    turnId: string,
    text: string,
  ): Promise<StoredWebchatMessage> {
    const part: Extract<MessagePart, { type: "text" }> = { type: "text", content: text };
    return this.insertBackendMessage(sessionId, turnId, "assistant", [part]);
  }

  /**
   * Persist a backend-initiated assistant message from arbitrary parts, pushed
   * live via message_insert. Used for in-turn commentary blocks and suspension
   * cards that must appear in the transcript as the turn streams (not only on
   * the post-turn reload). See {@link insertBackendMessage}.
   */
  async addBackendMessage(
    sessionId: string,
    turnId: string,
    parts: TranscriptPart[],
  ): Promise<StoredWebchatMessage> {
    return this.insertBackendMessage(sessionId, turnId, "assistant", parts);
  }

  /**
   * Append-only trace persistence (the hot path during an agent turn).
   *
   * Writes only each turn's new block tail rather than re-serializing and
   * rewriting the full accumulated trace on every event — a full-row rewrite
   * is O(N²) per turn on the main event loop and visibly stalls the web UI
   * once traces reach megabytes. Each block becomes one
   * `rome_agent_trace_blocks` row, and the trace message row is a
   * constant-size stub whose accounting columns are bumped incrementally so
   * usage rollups keep working unchanged.
   *
   * The stub insert (first batch only), block inserts, and accounting bump
   * commit in one transaction: a failed append leaves no partial state, so
   * the caller's `persistedTraceEventCount` cursor stays truthful and a
   * retry re-appends the same `startSeq` without double-counting. A replay
   * that *would* double-write trips the (message_id, seq) primary key and
   * fails loudly instead.
   */
  async appendTraceBlocks(input: {
    messageId: string;
    sessionId: string;
    turnId: string | null;
    /** 0-based index of the first block in `blocks` within the whole trace. */
    startSeq: number;
    /** Pre-shaped trace blocks (already passed through toTraceEvent). */
    blocks: unknown[];
    trigger?: RomeAgentTraceTriggerMetadata;
    transcriptMessages?: RomeAgentTranscriptMessageInput[];
  }): Promise<void> {
    if (input.blocks.length === 0) return;

    const totals = emptyTraceAccountingTotals();
    const blockRows = input.blocks.map((block, i) => {
      accumulateBlockAccounting(totals, block);
      return {
        messageId: input.messageId,
        seq: input.startSeq + i,
        sessionId: input.sessionId,
        content: JSON.stringify(block),
      };
    });
    const hasProjectionDelta = totals.hasAccounting;

    // `await` matters: better-sqlite3 transactions are synchronous, but the
    // call must stay awaited so a future async driver can't turn this into a
    // fire-and-forget write (same contract as deleteSession).
    await this.db.transaction((tx) => {
      const now = new Date();
      const insertTranscriptMessages = (messages: RomeAgentTranscriptMessageInput[]) => {
        for (const message of messages) {
          const accounting = traceAccountingColumns(message.role, message.content);
          const createdAt = message.role === "user" ? now : new Date(now.getTime() + 2);
          const result = tx
            .insert(romeAgentMessages)
            .values({
              id: message.id,
              sessionId: message.sessionId,
              turnId: message.turnId,
              role: message.role,
              content: message.content,
              cacheReadTokens: accounting?.hasAccounting ? accounting.cacheReadTokens : null,
              cacheWriteTokens: accounting?.hasAccounting ? accounting.cacheWriteTokens : null,
              costUsd: accounting?.hasCost ? accounting.costUsd : null,
              inputTokens: accounting?.hasAccounting ? accounting.inputTokens : null,
              outputTokens: accounting?.hasAccounting ? accounting.outputTokens : null,
              createdAt,
            })
            .onConflictDoNothing({ target: romeAgentMessages.id })
            .run();
          if (result.changes > 0) {
            tx.update(romeSessions)
              .set(advanceSessionActivitySet(createdAt))
              .where(eq(romeSessions.id, message.sessionId))
              .run();
          }
        }
      };
      // A chat session's lines are Chats': its prompt is recorded where it was
      // said and its answer is sent there, so only a session in no chat keeps
      // a transcript of its own.
      const inChat =
        tx
          .select({ chatId: romeSessions.chatId })
          .from(romeSessions)
          .where(eq(romeSessions.id, input.sessionId))
          .get()?.chatId != null;
      const transcriptMessages = inChat ? [] : (input.transcriptMessages ?? []);
      insertTranscriptMessages(transcriptMessages.filter((message) => message.role === "user"));

      if (input.startSeq === 0) {
        // Stub trace message row: identity, ordering, and accounting columns
        // live here; content stays a constant '[]'. DO NOTHING keeps a retry
        // of a failed *first* batch from erroring before the PK check below
        // gets its say on the block rows themselves.
        tx.insert(romeAgentMessages)
          .values({
            id: input.messageId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            role: "trace",
            content: "[]",
            triggerKind: input.trigger?.triggerKind ?? null,
            triggerName: input.trigger?.triggerName ?? null,
            triggerActionName: input.trigger?.triggerActionName ?? null,
            triggerExecutionId: input.trigger?.triggerExecutionId ?? null,
            rootActionExecutionId: input.trigger?.rootActionExecutionId ?? null,
            parentActionExecutionId: input.trigger?.parentActionExecutionId ?? null,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: null,
            inputTokens: 0,
            outputTokens: 0,
            createdAt: new Date(now.getTime() + 1),
          })
          .onConflictDoNothing({ target: romeAgentMessages.id })
          .run();
      }
      for (let i = 0; i < blockRows.length; i += TRACE_BLOCK_INSERT_CHUNK) {
        tx.insert(romeAgentTraceBlocks)
          .values(blockRows.slice(i, i + TRACE_BLOCK_INSERT_CHUNK))
          .run();
      }
      if (hasProjectionDelta) {
        tx.update(romeAgentMessages)
          .set({
            ...(totals.hasAccounting
              ? {
                  cacheReadTokens: sql`COALESCE(${romeAgentMessages.cacheReadTokens}, 0) + ${totals.cacheReadTokens}`,
                  cacheWriteTokens: sql`COALESCE(${romeAgentMessages.cacheWriteTokens}, 0) + ${totals.cacheWriteTokens}`,
                  ...(totals.hasCost
                    ? {
                        costUsd: sql`COALESCE(${romeAgentMessages.costUsd}, 0) + ${totals.costUsd}`,
                      }
                    : {}),
                  inputTokens: sql`COALESCE(${romeAgentMessages.inputTokens}, 0) + ${totals.inputTokens}`,
                  outputTokens: sql`COALESCE(${romeAgentMessages.outputTokens}, 0) + ${totals.outputTokens}`,
                }
              : {}),
          })
          .where(eq(romeAgentMessages.id, input.messageId))
          .run();
      }
      insertTranscriptMessages(
        transcriptMessages.filter((message) => message.role === "assistant"),
      );
    });
  }

  /**
   * The chats with a line said at or after `since`, by the session that
   * stands in each, most recently active first: the guardian's dashboard
   * chats, or chats on Rome's accounts of `accountKinds`. A projection over
   * Chats' tables for Dream's review.
   */
  async recentChats(
    since: Date,
    where: "dashboard" | { accountKinds: readonly string[] },
  ): Promise<RecentChat[]> {
    const cutoff = Math.floor(since.getTime() / 1000);
    const scope =
      where === "dashboard"
        ? sql`s.source_channel = 'webchat' AND s.type IN ('channel', 'webchat_handoff')`
        : sql`s.type = 'channel' AND coalesce(ch.connection_kind, s.source_channel)
            IN (SELECT value FROM json_each(${JSON.stringify(where.accountKinds)}))`;
    return this.db
      .all<{ id: string; chat_id: string; thread_id: string | null }>(sql`
        SELECT s.id, s.chat_id, s.thread_id FROM rome_sessions s
        LEFT JOIN channels ch ON ch.id = s.source_channel
        JOIN chat_messages m ON m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
        WHERE ${scope} AND m.said_at >= max(${cutoff}, s.created_at)
        GROUP BY s.id
        ORDER BY max(m.said_at) DESC
      `)
      .map((row) => ({ sessionId: row.id, chatId: row.chat_id, threadId: row.thread_id }));
  }

  async getMessages(sessionId: string) {
    return this.selectMessages([sessionId]);
  }

  /**
   * The transcript lines of `sessionIds`, each session's in the order the
   * dashboard draws them: partitioning by turn keeps a turn's user, assistant
   * and trace lines contiguous even when a later turn's prompt was said
   * before an earlier turn's reply.
   */
  private selectMessages(sessionIds: readonly string[]) {
    return this.db
      .all<LineRow>(sql`
        SELECT * FROM ${sessionLines(sessionIds)}
        ORDER BY session_id,
          MIN(created_at) OVER (PARTITION BY session_id, COALESCE(turn_id, id)),
          turn_id, created_at, line_order, seq
      `)
      .map(storedLine);
  }

  /** One user or assistant line of the session, with the actor that sent it,
   *  or null when the id is not a chat line of this session. */
  async getReplyTarget(
    sessionId: string,
    messageId: string,
  ): Promise<
    (StoredWebchatMessage & { role: "user" | "assistant"; actor: SessionActor | null }) | null
  > {
    const row = this.db.all<LineRow>(sql`
      SELECT * FROM ${sessionLines([sessionId])}
      WHERE id = ${messageId} AND role IN ('user', 'assistant')
    `)[0];
    if (!row) return null;
    return {
      ...storedLine(row),
      role: row.role as "user" | "assistant",
      actor: row.role === "user" ? actorOf(row.sender_id, row.sender_name) : null,
    };
  }

  async getHistoryMessages(
    threadId: string | null,
    since: Date,
  ): Promise<StoredWebchatHistoryMessage[]> {
    const sessions =
      threadId !== null
        ? [threadId]
        : this.db
            .select({ id: romeSessions.id })
            .from(romeSessions)
            .where(isWebchatChat)
            .all()
            .map((row) => row.id);
    if (sessions.length === 0) return [];
    return this.db
      .all<LineRow & { session_name: string; session_agent_name: string | null }>(sql`
        SELECT l.*, s.name AS session_name, s.agent_name AS session_agent_name
        FROM ${sessionLines(sessions)} l JOIN rome_sessions s ON s.id = l.session_id
        WHERE l.created_at >= ${Math.floor(since.getTime() / 1000)}
          AND l.role IN ('user', 'assistant')
        ORDER BY MIN(l.created_at) OVER (PARTITION BY l.session_id, COALESCE(l.turn_id, l.id)),
          l.created_at, CASE l.role WHEN 'user' THEN 0 ELSE 1 END, l.seq
      `)
      .map((row) => ({
        ...storedLine(row),
        sessionName: row.session_name,
        sessionAgentName: row.session_agent_name,
      }));
  }

  async getMessagesBatch(sessionIds: string[]) {
    if (sessionIds.length === 0) return [];
    return (await this.selectMessages(sessionIds)).map(
      ({ id, sessionId, turnId, role, content, createdAt }) => ({
        id,
        sessionId,
        turnId,
        role,
        content,
        createdAt,
      }),
    );
  }

  /** A session stays visible while it or any ancestor has recent conversation activity. */
  async getTraceArchivedSessionIds(
    sessionIds: readonly string[],
    cutoff = sessionTraceCutoff(),
  ): Promise<string[]> {
    if (sessionIds.length === 0) return [];
    const rows = await this.db.all<{ sessionId: string; lastMessageAt: number }>(sql`
      WITH RECURSIVE ancestors(session_id, ancestor_id, parent_id) AS (
        SELECT id, id, parent_session_id FROM ${romeSessions}
        WHERE ${inArray(romeSessions.id, [...new Set(sessionIds)])}
        UNION
        SELECT ancestors.session_id, parent.id, parent.parent_session_id
        FROM ancestors JOIN ${romeSessions} AS parent ON parent.id = ancestors.parent_id
      ),
      activity AS MATERIALIZED (
        SELECT session_id, max(created_at) AS last_message_at FROM ${romeAgentMessages}
        WHERE session_id IN (SELECT ancestor_id FROM ancestors)
          AND ${inArray(romeAgentMessages.role, TRACE_ACTIVITY_ROLES)}
        GROUP BY session_id
      )
      SELECT ancestors.session_id AS sessionId, max(activity.last_message_at) AS lastMessageAt
      FROM ancestors JOIN activity ON activity.session_id = ancestors.ancestor_id
      GROUP BY ancestors.session_id
    `);
    return rows
      .filter((row) => isSessionTraceArchived(new Date(row.lastMessageAt * 1000), cutoff))
      .map((row) => row.sessionId);
  }

  async getTraceContents(sessionId: string, options: TraceReadOptions = {}) {
    const archivedSessionIds = options.sessionActivityCutoff
      ? await this.getTraceArchivedSessionIds([sessionId], options.sessionActivityCutoff)
      : [];
    const onlyIds = options.messageIds;
    if (onlyIds && onlyIds.length === 0) return [];
    const stubs = await this.db
      .select(traceReadFields(archivedSessionIds))
      .from(romeAgentMessages)
      .where(
        and(
          eq(romeAgentMessages.sessionId, sessionId),
          eq(romeAgentMessages.role, "trace"),
          onlyIds ? inArray(romeAgentMessages.id, [...onlyIds]) : undefined,
        ),
      );
    if (stubs.length === 0 || archivedSessionIds.length > 0) return stubs.map(traceContentResult);

    const blockRows = await this.db
      .select({ messageId: romeAgentTraceBlocks.messageId, content: romeAgentTraceBlocks.content })
      .from(romeAgentTraceBlocks)
      .where(
        and(
          eq(romeAgentTraceBlocks.sessionId, sessionId),
          onlyIds ? inArray(romeAgentTraceBlocks.messageId, [...onlyIds]) : undefined,
        ),
      )
      .orderBy(asc(romeAgentTraceBlocks.messageId), asc(romeAgentTraceBlocks.seq));
    if (blockRows.length === 0) return stubs.map(traceContentResult);

    const blocksByMessage = new Map<string, string[]>();
    for (const row of blockRows) {
      const list = blocksByMessage.get(row.messageId);
      if (list) {
        list.push(row.content);
      } else {
        blocksByMessage.set(row.messageId, [row.content]);
      }
    }
    return stubs.map((stub) => ({
      ...traceContentResult(stub),
      content: mergeTraceContent(stub.content, blocksByMessage.get(stub.id) ?? []),
    }));
  }

  async getTraceContentsByTurns(
    refs: readonly { sessionId: string; turnId: string }[],
    options: TraceReadOptions = {},
  ) {
    const traceTurnKey = (sessionId: string, turnId: string): string =>
      JSON.stringify([sessionId, turnId]);
    const refsByKey = new Map(
      refs.map((ref) => [traceTurnKey(ref.sessionId, ref.turnId), ref] as const),
    );
    const uniqueRefs = [...refsByKey.values()];
    if (uniqueRefs.length === 0) return [];
    const requestedSessionIds = [...new Set(uniqueRefs.map((ref) => ref.sessionId))];
    const archivedSessionIds = new Set(
      options.sessionActivityCutoff
        ? await this.getTraceArchivedSessionIds(requestedSessionIds, options.sessionActivityCutoff)
        : [],
    );
    const sessionIds = requestedSessionIds.filter((id) => !archivedSessionIds.has(id));
    if (sessionIds.length === 0) return [];
    const turnIds = [...new Set(uniqueRefs.map((ref) => ref.turnId))];

    const candidateStubs = await this.db
      .select({
        id: romeAgentMessages.id,
        sessionId: romeAgentMessages.sessionId,
        turnId: romeAgentMessages.turnId,
        content: romeAgentMessages.content,
      })
      .from(romeAgentMessages)
      .where(
        and(
          eq(romeAgentMessages.role, "trace"),
          inArray(romeAgentMessages.sessionId, sessionIds),
          inArray(romeAgentMessages.turnId, turnIds),
        ),
      )
      .orderBy(
        asc(romeAgentMessages.sessionId),
        asc(romeAgentMessages.turnId),
        asc(romeAgentMessages.id),
      );
    const stubs = candidateStubs.filter(
      (stub): stub is typeof stub & { turnId: string } =>
        stub.turnId !== null && refsByKey.has(traceTurnKey(stub.sessionId, stub.turnId)),
    );
    if (stubs.length === 0) return [];

    const blockRows = await this.db
      .select({ messageId: romeAgentTraceBlocks.messageId, content: romeAgentTraceBlocks.content })
      .from(romeAgentTraceBlocks)
      .where(
        inArray(
          romeAgentTraceBlocks.messageId,
          stubs.map((stub) => stub.id),
        ),
      )
      .orderBy(asc(romeAgentTraceBlocks.messageId), asc(romeAgentTraceBlocks.seq));
    const blocksByMessage = new Map<string, string[]>();
    for (const row of blockRows) {
      const list = blocksByMessage.get(row.messageId);
      if (list) {
        list.push(row.content);
      } else {
        blocksByMessage.set(row.messageId, [row.content]);
      }
    }

    return stubs.map((stub) => ({
      id: stub.id,
      sessionId: stub.sessionId,
      turnId: stub.turnId,
      content: mergeTraceContent(stub.content, blocksByMessage.get(stub.id) ?? []),
    }));
  }

  /** Ordered block contents for one trace message; empty for legacy traces. */
  private async getTraceBlockContents(messageId: string): Promise<string[]> {
    const rows = await this.db
      .select({ content: romeAgentTraceBlocks.content })
      .from(romeAgentTraceBlocks)
      .where(eq(romeAgentTraceBlocks.messageId, messageId))
      .orderBy(asc(romeAgentTraceBlocks.seq));
    return rows.map((row) => row.content);
  }

  private async getUsageTotalsForScope(
    options: ProjectUsageTotalsOptions,
    sessionScopeFilter = sql``,
  ) {
    const totalsRows = (await this.db.all(sql`
      SELECT
        COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS totalInputTokens,
        COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS totalCacheReadTokens,
        COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS totalCacheWriteTokens,
        COALESCE(SUM(
          COALESCE(input_tokens, 0)
          + COALESCE(output_tokens, 0)
          + COALESCE(cache_read_tokens, 0)
          + COALESCE(cache_write_tokens, 0)
        ), 0) AS totalTokens,
        COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS totalCostUsd,
        COALESCE(SUM(
          CASE
            WHEN created_at >= ${Math.floor(options.monthStart.getTime() / 1000)} THEN COALESCE(cost_usd, 0)
            ELSE 0
          END
        ), 0) AS monthCostUsd,
        COALESCE(SUM(
          CASE
            WHEN created_at >= ${Math.floor(options.monthStart.getTime() / 1000)} THEN
              COALESCE(input_tokens, 0)
              + COALESCE(output_tokens, 0)
              + COALESCE(cache_read_tokens, 0)
              + COALESCE(cache_write_tokens, 0)
            ELSE 0
          END
        ), 0) AS monthTokens
      FROM rome_agent_messages
      WHERE role = 'trace'
        ${sessionScopeFilter}
    `)) as Array<{
      monthCostUsd: number | null;
      monthTokens: number | null;
      totalCacheReadTokens: number | null;
      totalCacheWriteTokens: number | null;
      totalCostUsd: number | null;
      totalInputTokens: number | null;
      totalTokens: number | null;
    }>;

    const dayStart = options.dayStart;
    const dailyRows = options.dayRanges
      ? await this.getUsageDayRangeTotals(options.dayRanges, sessionScopeFilter)
      : dayStart
        ? ((await this.db.all(sql`
          SELECT
            strftime('%Y-%m-%d', created_at, 'unixepoch', 'localtime') AS date,
            COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS inputTokens,
            COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS outputTokens,
            COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cacheReadTokens,
            COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cacheWriteTokens,
            COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS costUsd
          FROM rome_agent_messages
          WHERE role = 'trace'
            AND created_at >= ${Math.floor(dayStart.getTime() / 1000)}
            ${sessionScopeFilter}
          GROUP BY date
          ORDER BY date ASC
        `)) as Array<{
            cacheReadTokens: number | null;
            cacheWriteTokens: number | null;
            costUsd: number | null;
            date: string;
            inputTokens: number | null;
            outputTokens: number | null;
          }>)
        : [];

    const providerTotals = await this.getProviderUsageTotals(
      options.monthStart,
      sessionScopeFilter,
    );
    const providerDays = options.dayRanges
      ? await this.getProviderUsageDayRangeTotals(options.dayRanges, sessionScopeFilter)
      : [];

    const totals = totalsRows[0];
    return {
      providerDays,
      providerTotals,
      days: dailyRows.map((row) => ({
        cacheReadTokens: Number(row.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
        costUsd: Number(row.costUsd ?? 0),
        date: row.date,
        inputTokens: Number(row.inputTokens ?? 0),
        outputTokens: Number(row.outputTokens ?? 0),
      })),
      monthCostUsd: Number(totals?.monthCostUsd ?? 0),
      monthTokens: Number(totals?.monthTokens ?? 0),
      totalCacheReadTokens: Number(totals?.totalCacheReadTokens ?? 0),
      totalCacheWriteTokens: Number(totals?.totalCacheWriteTokens ?? 0),
      totalCostUsd: Number(totals?.totalCostUsd ?? 0),
      totalInputTokens: Number(totals?.totalInputTokens ?? 0),
      totalTokens: Number(totals?.totalTokens ?? 0),
    };
  }

  private async getUsageDayRangeTotals(dayRanges: ProjectUsageDayRange[], sessionScopeFilter: SQL) {
    if (dayRanges.length === 0) return [];

    const { dateCase, dateFilter } = usageDayRangeSql(dayRanges);
    return (await this.db.all(sql`
      SELECT
        ${dateCase} AS date,
        COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS inputTokens,
        COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS outputTokens,
        COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cacheReadTokens,
        COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cacheWriteTokens,
        COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS costUsd
      FROM rome_agent_messages
      WHERE role = 'trace'
        AND (${dateFilter})
        ${sessionScopeFilter}
      GROUP BY 1
      ORDER BY 1 ASC
    `)) as Array<{
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
      costUsd: number | null;
      date: string;
      inputTokens: number | null;
      outputTokens: number | null;
    }>;
  }

  private async getProviderUsageTotals(monthStart: Date, sessionScopeFilter: SQL) {
    const isThisMonth = sql`created_at >= ${Math.floor(monthStart.getTime() / 1000)}`;
    const total = providerUsageAmountsSql();
    const month = providerUsageAmountsSql(isThisMonth);
    const rows = (await this.db.all(sql`
      SELECT
        ${terminalBlockProviderSql} AS provider,
        ${total.inputTokens} AS totalInputTokens,
        ${total.outputTokens} AS totalOutputTokens,
        ${total.cacheReadTokens} AS totalCacheReadTokens,
        ${total.cacheWriteTokens} AS totalCacheWriteTokens,
        ${total.costUsd} AS totalCostUsd,
        ${month.inputTokens} AS monthInputTokens,
        ${month.outputTokens} AS monthOutputTokens,
        ${month.cacheReadTokens} AS monthCacheReadTokens,
        ${month.cacheWriteTokens} AS monthCacheWriteTokens,
        ${month.costUsd} AS monthCostUsd
      FROM (${terminalAccountingBlocksSql(sessionScopeFilter)})
      WHERE json_type(block, '$.accounting') = 'object'
      GROUP BY 1
      ORDER BY 1 ASC
    `)) as Array<Record<string, unknown> & { provider: string }>;

    return rows.map((row) => ({
      month: readProviderUsageAmounts(row, "month"),
      provider: row.provider,
      total: readProviderUsageAmounts(row, "total"),
    }));
  }

  private async getProviderUsageDayRangeTotals(
    dayRanges: ProjectUsageDayRange[],
    sessionScopeFilter: SQL,
  ) {
    if (dayRanges.length === 0) return [];

    const { dateCase, dateFilter } = usageDayRangeSql(dayRanges);
    const amounts = providerUsageAmountsSql();
    const rows = (await this.db.all(sql`
      SELECT
        ${dateCase} AS date,
        ${terminalBlockProviderSql} AS provider,
        ${amounts.inputTokens} AS dayInputTokens,
        ${amounts.outputTokens} AS dayOutputTokens,
        ${amounts.cacheReadTokens} AS dayCacheReadTokens,
        ${amounts.cacheWriteTokens} AS dayCacheWriteTokens,
        ${amounts.costUsd} AS dayCostUsd
      FROM (${terminalAccountingBlocksSql(sql`AND (${dateFilter}) ${sessionScopeFilter}`)})
      WHERE json_type(block, '$.accounting') = 'object'
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC
    `)) as Array<Record<string, unknown> & { date: string; provider: string }>;

    return rows.map((row) => ({
      ...readProviderUsageAmounts(row, "day"),
      date: row.date,
      provider: row.provider,
    }));
  }

  async getUsageTotals(options: ProjectUsageTotalsOptions) {
    return this.getUsageTotalsForScope(options);
  }

  async getProjectUsageTotals(projectPath: string, options: ProjectUsageTotalsOptions) {
    return this.getUsageTotalsForScope(
      options,
      sql`AND session_id IN (
        SELECT id FROM rome_sessions WHERE project_path = ${projectPath}
      )`,
    );
  }

  async hasTurnInSession(sessionId: string, turnId: string): Promise<boolean> {
    const rows = this.db.all(sql`
      SELECT 1 FROM rome_agent_messages WHERE session_id = ${sessionId} AND turn_id = ${turnId}
      UNION ALL
      SELECT 1 FROM agent_turn_messages WHERE session_id = ${sessionId} AND turn_id = ${turnId}
      LIMIT 1
    `);
    return rows.length > 0;
  }

  /** The rated exchange's visible chat lines (user prompt + assistant reply),
   *  excluding trace rows, in the order they were said. */
  async getTurnChatMessages(sessionId: string, turnId: string) {
    return this.db
      .all<LineRow>(sql`
        SELECT * FROM ${sessionLines([sessionId])}
        WHERE turn_id = ${turnId} AND role IN ('user', 'assistant')
        ORDER BY created_at, line_order, seq
      `)
      .map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        senderId: row.sender_id,
      }));
  }

  async getTraceContentByTurn(sessionId: string, turnId: string, options: TraceReadOptions = {}) {
    const archivedSessionIds = options.sessionActivityCutoff
      ? await this.getTraceArchivedSessionIds([sessionId], options.sessionActivityCutoff)
      : [];
    const rows = await this.db
      .select(traceReadFields(archivedSessionIds))
      .from(romeAgentMessages)
      .where(
        and(
          eq(romeAgentMessages.sessionId, sessionId),
          eq(romeAgentMessages.turnId, turnId),
          eq(romeAgentMessages.role, "trace"),
        ),
      )
      .limit(1);
    const stub = rows[0];
    if (!stub) return null;
    if (stub.traceArchived) return traceContentResult(stub);
    return {
      ...traceContentResult(stub),
      content: mergeTraceContent(stub.content, await this.getTraceBlockContents(stub.id)),
    };
  }

  async getMessageContentForDisplay(id: string, options: TraceReadOptions = {}) {
    // A chat line is the chat's, whichever session reads it.
    const line = this.db.all<{ parts: string }>(
      sql`SELECT parts FROM chat_messages WHERE id = ${id}`,
    )[0];
    if (line) return { id, content: line.parts };
    if (options.sessionActivityCutoff) {
      const [message] = await this.db
        .select({ sessionId: romeAgentMessages.sessionId, role: romeAgentMessages.role })
        .from(romeAgentMessages)
        .where(eq(romeAgentMessages.id, id));
      if (!message) return null;
      if (message.role === "trace") {
        const archivedSessionIds = await this.getTraceArchivedSessionIds(
          [message.sessionId],
          options.sessionActivityCutoff,
        );
        if (archivedSessionIds.length) return { id, content: "[]", traceArchived: true };
      }
    }
    const rows = await this.db
      .select(traceReadFields([]))
      .from(romeAgentMessages)
      .where(eq(romeAgentMessages.id, id));
    const stub = rows[0];
    if (!stub) return null;
    return {
      ...traceContentResult(stub),
      content: mergeTraceContent(stub.content, await this.getTraceBlockContents(id)),
    };
  }

  async getLayout(sessionId: string): Promise<unknown[] | null> {
    const rows = await this.db
      .select({ layout: webchatWorkspaceLayouts.layout })
      .from(webchatWorkspaceLayouts)
      .where(eq(webchatWorkspaceLayouts.sessionId, sessionId))
      .limit(1);
    if (!rows[0]) return null;
    try {
      const parsed = JSON.parse(rows[0].layout);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async saveLayout(sessionId: string, layout: unknown[]): Promise<void> {
    await this.db
      .insert(webchatWorkspaceLayouts)
      .values({
        sessionId,
        layout: JSON.stringify(layout),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: webchatWorkspaceLayouts.sessionId,
        set: {
          layout: JSON.stringify(layout),
          updatedAt: new Date(),
        },
      });
  }

  async createSharedChat(input: {
    id: string;
    sessionId: string;
    title: string;
    snapshot: string;
    layout: string;
    projectPath?: string | null;
  }): Promise<void> {
    await this.db.insert(sharedChats).values({
      id: input.id,
      sessionId: input.sessionId,
      title: input.title,
      snapshot: input.snapshot,
      layout: input.layout,
      projectPath: input.projectPath ?? null,
      createdAt: new Date(),
      revokedAt: null,
    });
  }

  /** A live (non-revoked) share by token, or null if missing/revoked. */
  async getSharedChat(id: string): Promise<StoredSharedChat | null> {
    const rows = await this.db
      .select({
        id: sharedChats.id,
        sessionId: sharedChats.sessionId,
        title: sharedChats.title,
        snapshot: sharedChats.snapshot,
        layout: sharedChats.layout,
        projectPath: sharedChats.projectPath,
        createdAt: sharedChats.createdAt,
        revokedAt: sharedChats.revokedAt,
      })
      .from(sharedChats)
      .where(eq(sharedChats.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.revokedAt) return null;
    return row;
  }

  /** All non-revoked shares for a session, newest first (management list). */
  async listSharedChatsBySession(sessionId: string): Promise<StoredSharedChatSummary[]> {
    return this.db
      .select({
        id: sharedChats.id,
        title: sharedChats.title,
        createdAt: sharedChats.createdAt,
      })
      .from(sharedChats)
      .where(and(eq(sharedChats.sessionId, sessionId), isNull(sharedChats.revokedAt)))
      .orderBy(desc(sharedChats.createdAt));
  }

  /** Soft-delete (revoke) a share. Returns true if a live row was revoked. */
  async revokeSharedChat(id: string): Promise<boolean> {
    const rows = await this.db
      .update(sharedChats)
      .set({ revokedAt: new Date() })
      .where(and(eq(sharedChats.id, id), isNull(sharedChats.revokedAt)))
      .returning({ id: sharedChats.id });
    return rows.length > 0;
  }

  async getTurnFeedback(sessionId: string, turnId: string): Promise<StoredTurnFeedback | null> {
    const rows = await this.db
      .select({
        rating: webchatTurnFeedback.rating,
        comment: webchatTurnFeedback.comment,
        updatedAt: webchatTurnFeedback.updatedAt,
      })
      .from(webchatTurnFeedback)
      .where(
        and(eq(webchatTurnFeedback.sessionId, sessionId), eq(webchatTurnFeedback.turnId, turnId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Write-once insert: atomically commit a feedback row for (sessionId, turnId)
   * via INSERT ... ON CONFLICT DO NOTHING. Returns the stored row on success,
   * or `null` if the composite PK already exists. The route turns `null` into
   * a 409 so a racing second POST cannot silently overwrite the first.
   */
  async insertTurnFeedback(
    sessionId: string,
    turnId: string,
    rating: TurnFeedbackRating,
    comment: string | null,
  ): Promise<StoredTurnFeedback | null> {
    const now = new Date();
    const inserted = await this.db
      .insert(webchatTurnFeedback)
      .values({
        sessionId,
        turnId,
        rating,
        comment,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [webchatTurnFeedback.sessionId, webchatTurnFeedback.turnId],
      })
      .returning({
        rating: webchatTurnFeedback.rating,
        comment: webchatTurnFeedback.comment,
        updatedAt: webchatTurnFeedback.updatedAt,
      });
    return inserted[0] ?? null;
  }
}

/** The dashboard's platform: Rome's own chat behind the guardian's sign-in. */
const WEBCHAT_PLATFORM = "webchat";

/** The dashboard account agent `agentName` says its lines as. */
function dashboardAccountId(agentName: string | null): string {
  return `agent:${agentName ?? "main"}`;
}

/** Who said a dashboard line the person `actor` sent: the guardian, or a
 *  visitor by their account, named by their email. */
function dashboardSender(actor: SessionActor | undefined): SaidBy {
  if (actor?.kind === "visitor") {
    return {
      account: { platform: WEBCHAT_PLATFORM, id: `visitor:${actor.accountId}` },
      name: actor.email,
    };
  }
  return { account: { platform: WEBCHAT_PLATFORM, id: "guardian" } };
}

/** The person a dashboard line's sender account stands for. */
function actorOf(senderId: string | null, senderName: string | null): SessionActor | null {
  if (senderId === "guardian") return { kind: "guardian", userId: "guardian", via: "cookie" };
  if (senderId?.startsWith("visitor:")) {
    return {
      kind: "visitor",
      accountId: senderId.slice("visitor:".length),
      email: senderName ?? "",
    };
  }
  return null;
}

/** A line's composed parts, read from its stored JSON, or one text part for
 *  plain text. */
function partsOf(content: string): MessagePart[] {
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed as MessagePart[];
  } catch {
    // Plain text.
  }
  return [{ type: "text", content }];
}

interface LineRow {
  id: string;
  session_id: string;
  turn_id: string | null;
  input_state: import("@rome-os/app-runtime").AgentInputState | null;
  role: string;
  content: string;
  created_at: number;
  sender_id: string | null;
  sender_name: string | null;
  line_order: number;
  seq: number;
  from_rome: number;
}

function storedLine(row: LineRow): StoredWebchatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    inputState: row.input_state,
    role: row.role,
    content: row.content,
    createdAt: new Date(row.created_at * 1000),
  };
}

/**
 * The transcript lines of `sessionIds`, as one table: what was said where
 * each session stands, from Chats, read as the session sees it, beside the
 * session's own lines (traces, and the text of a session that stands in no
 * chat). A line is the session's prompt or answer by its turn link; a line
 * with none is its agent's when its seat said it, the guardian's on the
 * dashboard, and a notification elsewhere. `line_order` puts a prompt before
 * the trace and answer of its turn within one second.
 */
function sessionLines(sessionIds: readonly string[]) {
  const ids = JSON.stringify(sessionIds);
  return sql`(
    SELECT m.id, s.id AS session_id,
      -- A line the turn only caught up on is no part of the turn.
      CASE WHEN l.role IN ('prompt', 'answer') THEN l.turn_id END AS turn_id, l.input_state,
      CASE WHEN l.role = 'answer'
             OR (l.role IS NULL AND m.sender_agent IS NOT NULL AND m.sender_account_id IS s.account_id)
             THEN 'assistant'
           WHEN l.role = 'prompt' OR s.source_channel = 'webchat' THEN 'user'
           ELSE 'notification' END AS role,
      m.parts AS content, m.said_at AS created_at, m.sender_account_id AS sender_id,
      m.sender_name, CASE WHEN l.role = 'prompt' THEN 0 ELSE 2 END AS line_order,
      m.rowid AS seq, m.sender_agent IS NOT NULL AS from_rome
    FROM rome_sessions s
    JOIN chat_messages m ON m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
      -- A seat sees the place from when it joined.
      AND m.said_at >= s.created_at
    LEFT JOIN agent_turn_messages l ON l.message_id = m.id AND l.session_id = s.id
    WHERE s.id IN (SELECT value FROM json_each(${ids}))
    UNION ALL
    SELECT r.id, r.session_id, r.turn_id, NULL AS input_state, r.role,
      CASE WHEN r.role = 'trace' THEN '[]' ELSE r.content END AS content,
      r.created_at, r.sender_id, r.sender_name,
      CASE WHEN r.role = 'user' THEN 0 WHEN r.role = 'trace' THEN 1 ELSE 2 END AS line_order,
      r.rowid AS seq, (r.role = 'assistant' OR r.sender_id IS 'rome') AS from_rome
    FROM rome_agent_messages r JOIN rome_sessions s ON s.id = r.session_id
    WHERE r.session_id IN (SELECT value FROM json_each(${ids}))
      AND (s.chat_id IS NULL OR r.role NOT IN ('user', 'assistant', 'notification'))
  )`;
}
