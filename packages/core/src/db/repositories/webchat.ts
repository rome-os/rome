import { createHash, randomUUID } from "node:crypto";
import { posix as pathPosix } from "node:path";
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
  or,
  sql,
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
import { DEFAULT_WEBCHAT_PROJECT_NAME } from "../../webchat/constants.js";
import type { TurnFeedbackRating } from "@rome/api-types/trace-segments";
import type { RomeSessionType } from "@rome-os/app-runtime";
import type { MessagePart } from "../../types.js";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";

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

const webchatMessageSelectFields = {
  id: romeAgentMessages.id,
  sessionId: romeAgentMessages.sessionId,
  turnId: romeAgentMessages.turnId,
  role: romeAgentMessages.role,
  content: romeAgentMessages.content,
  createdAt: romeAgentMessages.createdAt,
};

const sessionSelectFields = {
  id: romeSessions.id,
  name: romeSessions.name,
  personaId: romeSessions.personaId,
  largeModelSelection: romeSessions.largeModelSelection,
  projectName: romeSessions.projectName,
  projectPath: romeSessions.projectPath,
  agentName: romeSessions.agentName,
  archivedAt: romeSessions.archivedAt,
  pinnedAt: romeSessions.pinnedAt,
  createdAt: romeSessions.createdAt,
  activityAt: sql<number>`cast(${romeSessions.activityAt} as integer)`.mapWith(Number),
  lastSeenActivityAt: romeSessions.lastSeenActivityAt,
  unread:
    sql<boolean>`case when ${romeSessions.lastSeenActivityAt} is not null and ${romeSessions.activityAt} > ${romeSessions.lastSeenActivityAt} then 1 else 0 end`.mapWith(
      Boolean,
    ),
  messageCount:
    sql<number>`(select count(*) from "rome_agent_messages" where "rome_agent_messages"."session_id" = "rome_sessions"."id")`.mapWith(
      Number,
    ),
};

const sessionActivityAt = sql<number>`cast(${romeSessions.activityAt} as integer)`;
const SESSION_DELETE_CHUNK_SIZE = 500;
const CONVERSATION_CONTEXT_NOTIFICATION_LIMIT = 20;
const SQL_LIKE_ESCAPE = "\\";

// Transcript search: how many LIKE-prefiltered message rows the JS confirm
// pass scans at most, and the shape of the snippet cut around the first hit.
const SEARCH_MESSAGE_SCAN_LIMIT = 400;
const SEARCH_SNIPPET_CONTEXT = 40;
const SEARCH_SNIPPET_LENGTH = 160;

export function channelConversationId(channel: string, threadId: string): string {
  return `channel:${channel}:${threadId}`;
}

/** The row id a recorded outbound message takes when the provider named it.
 *  Derived rather than random so a caller that knows the provider's id can
 *  predict the timeline `ref` the message will carry — which is how the
 *  outbox knows a send has landed (`src/people/outbox.ts`). */
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

/**
 * Flattens a stored message's JSON block array into the transcript text a
 * guardian actually sees: `text` block contents joined, whitespace collapsed.
 * Non-text blocks (tool calls, attachments, …) never contribute, so JSON keys
 * and tool payloads can't produce phantom search hits.
 */
function extractTranscriptText(content: string): string {
  let blocks: unknown;
  try {
    blocks = JSON.parse(content);
  } catch {
    return "";
  }
  if (!Array.isArray(blocks)) return "";
  const texts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const type = (block as { type?: unknown }).type;
    const text = (block as { content?: unknown }).content;
    if (type === "text" && typeof text === "string" && text.trim()) texts.push(text);
  }
  return texts.join("\n").replace(/\s+/g, " ").trim();
}

/**
 * Confirms every lowercased `term` occurs in `text` (case-insensitive) and
 * returns a single-line snippet cut around the earliest hit, ellipsized on
 * clipped ends. Returns null when any term is missing — the SQL LIKE prefilter
 * matches raw JSON, so this is the authoritative check.
 */
function buildTranscriptSnippet(text: string, terms: string[]): string | null {
  const lowered = text.toLocaleLowerCase();
  let firstHit = Number.POSITIVE_INFINITY;
  for (const term of terms) {
    const at = lowered.indexOf(term);
    if (at === -1) return null;
    if (at < firstHit) firstHit = at;
  }
  if (!Number.isFinite(firstHit)) return null;

  let start = Math.max(0, firstHit - SEARCH_SNIPPET_CONTEXT);
  if (start > 0) {
    // Snap the left edge forward to a word boundary when one sits before the hit.
    const boundary = text.indexOf(" ", start);
    if (boundary !== -1 && boundary < firstHit) start = boundary + 1;
  }
  const end = Math.min(text.length, start + SEARCH_SNIPPET_LENGTH);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
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

  constructor(private db: DrizzleDb) {}

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
        type: romeSessions.type,
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
  ) {
    const now = new Date();
    if (projectPath?.trim()) {
      await this.ensureProject(projectPath, projectName);
    }

    await this.db.insert(romeSessions).values({
      id,
      name,
      personaId: personaId ?? null,
      projectName,
      projectPath,
      largeModelSelection: largeModelSelection ?? null,
      agentName,
      type,
      sourceChannel: "webchat",
      sourceThreadId: id,
      sourceThreadName: name,
      sourceThreadType: "private",
      handoffSpec,
      createdAt: now,
      activityAt: now,
      lastSeenActivityAt: type === "webchat" ? now : null,
    });
  }

  async ensureRomeSession(input: EnsureRomeSessionInput): Promise<void> {
    const now = new Date();
    await this.db
      .insert(romeSessions)
      .values({
        id: input.id,
        name: input.name,
        personaId: null,
        projectName: input.projectName ?? DEFAULT_WEBCHAT_PROJECT_NAME,
        projectPath: input.projectPath ?? null,
        largeModelSelection: null,
        agentName: input.agentName,
        type: input.type,
        sourceChannel: input.sourceChannel ?? null,
        sourceThreadId: input.sourceThreadId ?? null,
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
        lastSeenActivityAt: input.type === "webchat" ? now : null,
      })
      .onConflictDoNothing({ target: romeSessions.id });
  }

  async ensureChannelConversation(input: {
    channel: string;
    threadId: string;
    parentThreadId?: string;
    threadName?: string;
    threadType?: "private" | "group";
    agentName: string;
    projectName?: string;
    projectPath?: string;
  }): Promise<{ id: string; agentName: string | null }> {
    const parent =
      input.parentThreadId && input.parentThreadId !== input.threadId
        ? await this.ensureChannelConversation({
            ...input,
            threadId: input.parentThreadId,
            parentThreadId: undefined,
            threadName: undefined,
            threadType: "group",
          })
        : null;
    const existing = await this.findChannelConversation(input.channel, input.threadId);
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

    const id = channelConversationId(input.channel, input.threadId);
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
        createdAt: now,
        activityAt: now,
        lastSeenActivityAt: null,
      })
      .onConflictDoNothing();

    const conversation = await this.findChannelConversation(input.channel, input.threadId);
    if (!conversation) {
      throw new Error(`Failed to resolve conversation ${input.channel}:${input.threadId}`);
    }
    return conversation;
  }

  async addConversationMessage(input: {
    sessionId: string;
    role: "user" | "notification";
    content: string;
    platformMessageId: string;
    senderId?: string;
    senderName?: string;
    replyToPlatformMessageId?: string;
    createdAt?: Date;
  }): Promise<{ inserted: boolean }> {
    const createdAt = input.createdAt ?? new Date();
    // The row and the session activity it advances are one fact. Splitting them
    // across two writes lets a failure in between store the message against
    // stale activity, which sorts the conversation by the wrong timestamp.
    return this.db.transaction((tx) => {
      const rows = tx
        .insert(romeAgentMessages)
        .values({
          id: conversationPlatformMessageId(input.sessionId, input.platformMessageId),
          sessionId: input.sessionId,
          turnId: null,
          role: input.role,
          content: input.content,
          platformMessageId: input.platformMessageId,
          senderId: input.senderId ?? null,
          senderName: input.senderName ?? null,
          replyToPlatformMessageId: input.replyToPlatformMessageId ?? null,
          contextInjectedTurnId: null,
          createdAt,
        })
        .onConflictDoNothing()
        .returning({ id: romeAgentMessages.id })
        .all();
      // A platform message id we already stored is a redelivery, not new
      // activity — leave the session's timestamp where it is.
      if (rows.length === 0) return { inserted: false };
      tx.update(romeSessions)
        .set(advanceSessionActivitySet(createdAt))
        .where(eq(romeSessions.id, input.sessionId))
        .run();
      return { inserted: true };
    });
  }

  async promoteConversationMessageToUser(
    sessionId: string,
    platformMessageId: string,
  ): Promise<void> {
    await this.db
      .update(romeAgentMessages)
      .set({ role: "user" })
      .where(
        and(
          eq(romeAgentMessages.sessionId, sessionId),
          eq(romeAgentMessages.platformMessageId, platformMessageId),
          eq(romeAgentMessages.role, "notification"),
        ),
      );
  }

  async assignConversationMessageTurn(
    sessionId: string,
    platformMessageId: string,
    turnId: string,
  ): Promise<void> {
    await this.db
      .update(romeAgentMessages)
      .set({ turnId })
      .where(
        and(
          eq(romeAgentMessages.sessionId, sessionId),
          eq(romeAgentMessages.platformMessageId, platformMessageId),
          eq(romeAgentMessages.role, "user"),
        ),
      );
  }

  async recordOutboundConversationMessage(input: {
    sessionId: string;
    content: string;
    platformMessageId?: string;
    senderId?: string;
    senderName?: string;
    replyToPlatformMessageId?: string;
    turnId?: string;
    knownToProvider: boolean;
  }): Promise<void> {
    if (input.platformMessageId) {
      const delivered = await this.db
        .select({ id: romeAgentMessages.id })
        .from(romeAgentMessages)
        .where(
          and(
            eq(romeAgentMessages.sessionId, input.sessionId),
            eq(romeAgentMessages.platformMessageId, input.platformMessageId),
          ),
        )
        .limit(1);
      if (delivered[0]) {
        await this.db
          .update(romeAgentMessages)
          .set({
            role: input.knownToProvider ? "assistant" : "notification",
            turnId: input.turnId ?? null,
            senderId: input.senderId ?? null,
            senderName: input.senderName ?? null,
            replyToPlatformMessageId: input.replyToPlatformMessageId ?? null,
          })
          .where(eq(romeAgentMessages.id, delivered[0].id));
        return;
      }
    }
    if (input.knownToProvider && input.turnId) {
      const existing = await this.db
        .select({ id: romeAgentMessages.id })
        .from(romeAgentMessages)
        .where(
          and(
            eq(romeAgentMessages.sessionId, input.sessionId),
            eq(romeAgentMessages.turnId, input.turnId),
            eq(romeAgentMessages.role, "assistant"),
            eq(romeAgentMessages.content, input.content),
          ),
        )
        .orderBy(desc(romeAgentMessages.createdAt))
        .limit(1);
      if (existing[0]) {
        await this.db
          .update(romeAgentMessages)
          .set({
            platformMessageId: input.platformMessageId ?? null,
            senderId: input.senderId ?? null,
            senderName: input.senderName ?? null,
            replyToPlatformMessageId: input.replyToPlatformMessageId ?? null,
          })
          .where(eq(romeAgentMessages.id, existing[0].id));
        return;
      }
    }

    const createdAt = new Date();
    await this.db.transaction((tx) => {
      tx.insert(romeAgentMessages)
        .values({
          id: input.platformMessageId
            ? conversationPlatformMessageId(input.sessionId, input.platformMessageId)
            : randomUUID(),
          sessionId: input.sessionId,
          turnId: input.turnId ?? null,
          role: input.knownToProvider ? "assistant" : "notification",
          content: input.content,
          platformMessageId: input.platformMessageId ?? null,
          senderId: input.senderId ?? null,
          senderName: input.senderName ?? null,
          replyToPlatformMessageId: input.replyToPlatformMessageId ?? null,
          contextInjectedTurnId: null,
          createdAt,
        })
        .onConflictDoNothing()
        .run();
      tx.update(romeSessions)
        .set(advanceSessionActivitySet(createdAt))
        .where(eq(romeSessions.id, input.sessionId))
        .run();
    });
  }

  async loadConversationContext(
    sessionId: string,
    replyToPlatformMessageId?: string,
  ): Promise<{
    notifications: StoredConversationContextMessage[];
    pendingNotificationIds: string[];
    omittedNotificationCount: number;
    repliedTo: StoredConversationContextMessage | null;
  }> {
    const pendingNotificationRows = await this.db
      .select({
        id: romeAgentMessages.id,
        senderId: romeAgentMessages.senderId,
        replyToPlatformMessageId: romeAgentMessages.replyToPlatformMessageId,
      })
      .from(romeAgentMessages)
      .where(
        and(
          eq(romeAgentMessages.sessionId, sessionId),
          eq(romeAgentMessages.role, "notification"),
          isNull(romeAgentMessages.contextInjectedTurnId),
        ),
      )
      .orderBy(asc(romeAgentMessages.createdAt), asc(romeAgentMessages.id));
    const pendingNotificationIds = pendingNotificationRows.map((row) => row.id);
    const projectedNotificationIds = pendingNotificationIds.slice(
      -CONVERSATION_CONTEXT_NOTIFICATION_LIMIT,
    );
    const notifications =
      projectedNotificationIds.length === 0
        ? []
        : await this.db
            .select({
              id: romeAgentMessages.id,
              content: romeAgentMessages.content,
              senderName: romeAgentMessages.senderName,
              createdAt: romeAgentMessages.createdAt,
            })
            .from(romeAgentMessages)
            .where(inArray(romeAgentMessages.id, projectedNotificationIds))
            .orderBy(asc(romeAgentMessages.createdAt), asc(romeAgentMessages.id));
    const findMessageInSession = async (targetSessionId: string, platformMessageId: string) =>
      await this.db
        .select({
          id: romeAgentMessages.id,
          content: romeAgentMessages.content,
          senderName: romeAgentMessages.senderName,
          createdAt: romeAgentMessages.createdAt,
        })
        .from(romeAgentMessages)
        .where(
          and(
            eq(romeAgentMessages.sessionId, targetSessionId),
            eq(romeAgentMessages.platformMessageId, platformMessageId),
          ),
        )
        .limit(1);
    let parentSessionId: string | null | undefined;
    const loadParentSessionId = async (): Promise<string | null> => {
      if (parentSessionId !== undefined) return parentSessionId;
      const sessionRows = await this.db
        .select({ parentSessionId: romeSessions.parentSessionId })
        .from(romeSessions)
        .where(eq(romeSessions.id, sessionId))
        .limit(1);
      parentSessionId = sessionRows[0]?.parentSessionId ?? null;
      return parentSessionId;
    };

    // A newly created child conversation stores Rome's first reply as a
    // pending notification that references the triggering parent message.
    // Carry that one message with the notification; consuming the notification
    // keeps this context one-shot without copying or mutating the parent row.
    const parentReferenceMessageId = pendingNotificationRows.find(
      (row) => row.senderId === "rome" && row.replyToPlatformMessageId,
    )?.replyToPlatformMessageId;
    let contextualNotifications = notifications;
    if (parentReferenceMessageId) {
      const referencedParentSessionId = await loadParentSessionId();
      if (referencedParentSessionId) {
        const parentMessageRows = await findMessageInSession(
          referencedParentSessionId,
          parentReferenceMessageId,
        );
        const parentMessage = parentMessageRows[0];
        if (parentMessage) contextualNotifications = [parentMessage, ...notifications];
      }
    }
    const context = {
      notifications: contextualNotifications,
      pendingNotificationIds,
      omittedNotificationCount: pendingNotificationIds.length - notifications.length,
    };

    if (!replyToPlatformMessageId) return { ...context, repliedTo: null };
    const repliedRows = await findMessageInSession(sessionId, replyToPlatformMessageId);
    if (repliedRows[0]) return { ...context, repliedTo: repliedRows[0] };

    // A provider-native thread may quote its root message from the parent
    // conversation. Resolve that one explicit relation without merging the
    // parent's pending notifications into the child thread.
    const parentSessionIdForReply = await loadParentSessionId();
    if (!parentSessionIdForReply) return { ...context, repliedTo: null };
    const parentReplyRows = await findMessageInSession(
      parentSessionIdForReply,
      replyToPlatformMessageId,
    );
    return { ...context, repliedTo: parentReplyRows[0] ?? null };
  }

  async markConversationContextInjected(messageIds: string[], turnId: string): Promise<void> {
    if (messageIds.length === 0) return;
    await this.db
      .update(romeAgentMessages)
      .set({ contextInjectedTurnId: turnId })
      .where(
        and(
          inArray(romeAgentMessages.id, messageIds),
          eq(romeAgentMessages.role, "notification"),
          isNull(romeAgentMessages.contextInjectedTurnId),
        ),
      );
  }

  private async findChannelConversation(
    channel: string,
    threadId: string,
  ): Promise<{ id: string; agentName: string | null } | null> {
    const rows = await this.db
      .select({ id: romeSessions.id, agentName: romeSessions.agentName })
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

  async deleteSession(id: string) {
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

  async listSessions(status: "active" | "archived" | "all" = "active") {
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
      .select(sessionSelectFields)
      .from(romeSessions)
      .where(and(eq(romeSessions.type, "webchat"), archivePredicate))
      .orderBy(desc(romeSessions.activityAt), desc(romeSessions.createdAt), desc(romeSessions.id));
  }

  /**
   * Searches the guardian-visible transcript (user + assistant messages) of
   * top-level webchat sessions. Matching is case-insensitive and every
   * whitespace-separated term of `query` must occur in the same message's
   * text. Returns at most one match per session — its most recent matching
   * message — ordered by message recency, capped at `sessionLimit` sessions.
   */
  async searchSessionMessages(query: string, options: { sessionLimit?: number } = {}) {
    const sessionLimit = Math.max(1, options.sessionLimit ?? 20);
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    // Cheap SQL prefilter over the raw JSON content; buildTranscriptSnippet
    // re-checks against extracted text so JSON structure can't match.
    const likePredicates = terms.map(
      (term) =>
        sql`lower(${romeAgentMessages.content}) LIKE ${`%${escapeSqlLikePattern(term)}%`} ESCAPE ${SQL_LIKE_ESCAPE}`,
    );
    const rows = await this.db
      .select({ message: webchatMessageSelectFields, session: sessionSelectFields })
      .from(romeAgentMessages)
      .innerJoin(romeSessions, eq(romeAgentMessages.sessionId, romeSessions.id))
      .where(
        and(
          eq(romeSessions.type, "webchat"),
          inArray(romeAgentMessages.role, ["user", "assistant", "notification"]),
          ...likePredicates,
        ),
      )
      .orderBy(desc(romeAgentMessages.createdAt), desc(romeAgentMessages.id))
      .limit(SEARCH_MESSAGE_SCAN_LIMIT);

    const matches: {
      session: (typeof rows)[number]["session"];
      message: {
        id: string;
        role: "user" | "assistant" | "notification";
        createdAt: Date;
        snippet: string;
      };
    }[] = [];
    const seenSessions = new Set<string>();
    for (const row of rows) {
      if (seenSessions.has(row.session.id)) continue;
      const text = extractTranscriptText(row.message.content);
      if (!text) continue;
      const snippet = buildTranscriptSnippet(text, terms);
      if (!snippet) continue;
      seenSessions.add(row.session.id);
      matches.push({
        session: row.session,
        message: {
          id: row.message.id,
          role: row.message.role as "user" | "assistant" | "notification",
          createdAt: row.message.createdAt,
          snippet,
        },
      });
      if (matches.length >= sessionLimit) break;
    }
    return matches;
  }

  async archiveSession(id: string, options: { now?: Date } = {}) {
    // Scoped to top-level webchat rows: no other session type ever carries the
    // archive flag, so the type guard lives in the WHERE.
    const now = options.now ?? new Date();
    await this.db
      .update(romeSessions)
      .set({ archivedAt: now })
      .where(and(eq(romeSessions.id, id), eq(romeSessions.type, "webchat")));
  }

  async unarchiveSession(id: string, _options: { now?: Date } = {}) {
    await this.db
      .update(romeSessions)
      .set({ archivedAt: null })
      .where(and(eq(romeSessions.id, id), eq(romeSessions.type, "webchat")));
  }

  async pinSession(id: string, options: { now?: Date } = {}) {
    const now = options.now ?? new Date();
    await this.db
      .update(romeSessions)
      .set({ pinnedAt: now })
      .where(and(eq(romeSessions.id, id), eq(romeSessions.type, "webchat")));
  }

  async unpinSession(id: string) {
    await this.db
      .update(romeSessions)
      .set({ pinnedAt: null })
      .where(and(eq(romeSessions.id, id), eq(romeSessions.type, "webchat")));
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
    const predicates = [
      eq(romeSessions.projectPath, projectPath),
      eq(romeSessions.type, "webchat"),
      cursorPredicate,
    ];

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
      .where(and(eq(romeSessions.projectPath, projectPath), eq(romeSessions.type, "webchat")));

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
    const predicates = [eq(romeSessions.type, "webchat"), cursorPredicate];

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
      .where(eq(romeSessions.type, "webchat"));

    return {
      nextCursor,
      sessions,
      total: countRows[0]?.count ?? 0,
    };
  }

  async getSession(id: string) {
    const rows = await this.db.select().from(romeSessions).where(eq(romeSessions.id, id));
    return rows[0] ?? null;
  }

  async markSessionRead(id: string) {
    const rows = await this.db
      .update(romeSessions)
      .set({ lastSeenActivityAt: sql`${romeSessions.activityAt}` })
      .where(eq(romeSessions.id, id))
      .returning();
    return rows[0] ?? null;
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

  async updateSessionLargeModelSelection(id: string, largeModelSelection: string) {
    await this.db.update(romeSessions).set({ largeModelSelection }).where(eq(romeSessions.id, id));
  }

  async getMessageCount(sessionId: string) {
    const rows = await this.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(romeAgentMessages)
      .where(eq(romeAgentMessages.sessionId, sessionId));
    return rows[0]?.count ?? 0;
  }

  async recordUserInput(id: string, sessionId: string, content: string): Promise<boolean> {
    return this.db.transaction((tx) => {
      const createdAt = new Date();
      const inserted = tx
        .insert(romeAgentMessages)
        .values({
          id,
          sessionId,
          content,
          role: "user",
          inputState: "queued",
          createdAt,
        })
        .onConflictDoNothing()
        .returning({ id: romeAgentMessages.id })
        .all();
      if (inserted.length)
        tx.update(romeSessions)
          .set(advanceSessionActivitySet(createdAt))
          .where(eq(romeSessions.id, sessionId))
          .run();
      return inserted.length > 0;
    });
  }

  async recoverInterruptedInputs(): Promise<void> {
    // A process crash can occur between the durable dispatch marker and the
    // provider acknowledgement. Preserve the message without replaying it.
    await this.db
      .update(romeAgentMessages)
      .set({ inputState: "unknown" })
      .where(inArray(romeAgentMessages.inputState, ["queued", "submitted", "accepted"]));
  }

  async getUserInput(sessionId: string, inputId: string) {
    return this.db
      .select({ turnId: romeAgentMessages.turnId, inputState: romeAgentMessages.inputState })
      .from(romeAgentMessages)
      .where(
        and(
          eq(romeAgentMessages.id, inputId),
          eq(romeAgentMessages.sessionId, sessionId),
          eq(romeAgentMessages.role, "user"),
        ),
      )
      .get();
  }

  async updateUserInput(
    sessionId: string,
    status: import("@rome-os/app-runtime").InputStatusMessage,
  ): Promise<void> {
    await this.db
      .update(romeAgentMessages)
      .set({ inputState: status.state, turnId: status.turnId ?? null })
      .where(
        and(
          eq(romeAgentMessages.id, status.inputId),
          eq(romeAgentMessages.sessionId, sessionId),
          eq(romeAgentMessages.role, "user"),
        ),
      );
  }

  async addMessage(
    id: string,
    sessionId: string,
    role: string,
    content: string,
    turnId: string | null = null,
  ) {
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

  /**
   * Persist a backend-initiated message and notify subscribers.
   *
   * Backend-initiated messages — turn recaps, approval-continuation replies,
   * any agent output produced outside a foreground user turn — have no
   * per-turn SSE stream the browser is attached to, so the `message_inserted`
   * push is the only path by which the session view learns the row exists.
   * User-initiated turns deliberately do NOT notify on insert (their content
   * renders live off the per-turn stream and would otherwise double with the
   * pushed row) — that's why `addMessage` stays silent and this is separate.
   *
   * Callers own how the message is constructed (the parts); this owns the
   * shared persist-and-notify tail.
   */
  private async insertBackendMessage(
    sessionId: string,
    turnId: string,
    role: string,
    parts: MessagePart[],
  ): Promise<StoredWebchatMessage> {
    const message = await this.db.transaction((tx) => {
      const createdAt = new Date();
      const rows = tx
        .insert(romeAgentMessages)
        .values({
          id: randomUUID(),
          sessionId,
          turnId,
          role,
          content: JSON.stringify(parts),
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
          createdAt,
        })
        .returning(webchatMessageSelectFields)
        .all();
      if (isVisibleChatRole(role)) {
        tx.update(romeSessions)
          .set(advanceSessionActivitySet(createdAt))
          .where(eq(romeSessions.id, sessionId))
          .run();
      }
      return rows[0];
    });
    if (!message) {
      throw new Error("Failed to insert backend-initiated message");
    }
    this.emitMessageInserted(message);
    return message;
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
    parts: MessagePart[],
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
   * the caller's `persistedTraceBlockCount` cursor stays truthful and a
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
    /** Pre-shaped trace blocks (already passed through toTraceBlock). */
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
      const transcriptMessages = input.transcriptMessages ?? [];
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

  async updateMessageContent(id: string, content: string) {
    const rows = await this.db
      .select({ role: romeAgentMessages.role })
      .from(romeAgentMessages)
      .where(eq(romeAgentMessages.id, id))
      .limit(1);
    const accounting = rows[0] ? traceAccountingColumns(rows[0].role, content) : null;

    await this.db
      .update(romeAgentMessages)
      .set({
        content,
        cacheReadTokens: accounting?.hasAccounting ? accounting.cacheReadTokens : null,
        cacheWriteTokens: accounting?.hasAccounting ? accounting.cacheWriteTokens : null,
        costUsd: accounting?.hasCost ? accounting.costUsd : null,
        inputTokens: accounting?.hasAccounting ? accounting.inputTokens : null,
        outputTokens: accounting?.hasAccounting ? accounting.outputTokens : null,
      })
      .where(eq(romeAgentMessages.id, id));
  }

  async getMessages(sessionId: string) {
    // Partitioning by turn (not raw createdAt) keeps a turn's user/assistant/
    // trace rows contiguous even when a later turn's user row is inserted
    // before an earlier turn's reply; within a group, user sorts before
    // assistant/trace because handleChatSend inserts it first.
    return this.db
      .select({
        id: romeAgentMessages.id,
        sessionId: romeAgentMessages.sessionId,
        turnId: romeAgentMessages.turnId,
        inputState: romeAgentMessages.inputState,
        role: romeAgentMessages.role,
        content:
          sql<string>`CASE WHEN ${romeAgentMessages.role} = 'trace' THEN '[]' ELSE ${romeAgentMessages.content} END`.as(
            "content",
          ),
        createdAt: romeAgentMessages.createdAt,
      })
      .from(romeAgentMessages)
      .where(eq(romeAgentMessages.sessionId, sessionId))
      .orderBy(
        sql`MIN(${romeAgentMessages.createdAt}) OVER (PARTITION BY COALESCE(${romeAgentMessages.turnId}, ${romeAgentMessages.id}))`,
        asc(romeAgentMessages.turnId),
        asc(romeAgentMessages.createdAt),
      );
  }

  async getHistoryMessages(
    threadId: string | null,
    since: Date,
  ): Promise<StoredWebchatHistoryMessage[]> {
    const predicates = [
      gte(romeAgentMessages.createdAt, since),
      inArray(romeAgentMessages.role, ["user", "assistant"]),
    ];
    if (threadId !== null) {
      predicates.push(eq(romeAgentMessages.sessionId, threadId));
    } else {
      predicates.push(eq(romeSessions.type, "webchat"));
    }

    return this.db
      .select({
        ...webchatMessageSelectFields,
        sessionName: romeSessions.name,
        sessionAgentName: romeSessions.agentName,
      })
      .from(romeAgentMessages)
      .innerJoin(romeSessions, eq(romeSessions.id, romeAgentMessages.sessionId))
      .where(and(...predicates))
      .orderBy(
        sql`MIN(${romeAgentMessages.createdAt}) OVER (PARTITION BY ${romeAgentMessages.sessionId}, COALESCE(${romeAgentMessages.turnId}, ${romeAgentMessages.id}))`,
        asc(romeAgentMessages.createdAt),
        sql`CASE WHEN ${romeAgentMessages.role} = 'user' THEN 0 WHEN ${romeAgentMessages.role} = 'assistant' THEN 1 ELSE 2 END`,
        asc(romeAgentMessages.id),
      );
  }

  async getMessagesBatch(sessionIds: string[]) {
    if (sessionIds.length === 0) return [];

    return this.db
      .select({
        id: romeAgentMessages.id,
        sessionId: romeAgentMessages.sessionId,
        turnId: romeAgentMessages.turnId,
        role: romeAgentMessages.role,
        content:
          sql<string>`CASE WHEN ${romeAgentMessages.role} = 'trace' THEN '[]' ELSE ${romeAgentMessages.content} END`.as(
            "content",
          ),
        createdAt: romeAgentMessages.createdAt,
      })
      .from(romeAgentMessages)
      .where(inArray(romeAgentMessages.sessionId, sessionIds))
      .orderBy(
        asc(romeAgentMessages.sessionId),
        sql`MIN(${romeAgentMessages.createdAt}) OVER (PARTITION BY ${romeAgentMessages.sessionId}, COALESCE(${romeAgentMessages.turnId}, ${romeAgentMessages.id}))`,
        asc(romeAgentMessages.turnId),
        asc(romeAgentMessages.createdAt),
      );
  }

  async getTraceContents(sessionId: string) {
    const stubs = await this.db
      .select({ id: romeAgentMessages.id, content: romeAgentMessages.content })
      .from(romeAgentMessages)
      .where(and(eq(romeAgentMessages.sessionId, sessionId), eq(romeAgentMessages.role, "trace")));
    if (stubs.length === 0) return stubs;

    const blockRows = await this.db
      .select({ messageId: romeAgentTraceBlocks.messageId, content: romeAgentTraceBlocks.content })
      .from(romeAgentTraceBlocks)
      .where(eq(romeAgentTraceBlocks.sessionId, sessionId))
      .orderBy(asc(romeAgentTraceBlocks.messageId), asc(romeAgentTraceBlocks.seq));
    if (blockRows.length === 0) return stubs;

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
      content: mergeTraceContent(stub.content, blocksByMessage.get(stub.id) ?? []),
    }));
  }

  async getTraceContentsByTurns(refs: readonly { sessionId: string; turnId: string }[]) {
    const traceTurnKey = (sessionId: string, turnId: string): string =>
      JSON.stringify([sessionId, turnId]);
    const refsByKey = new Map(
      refs.map((ref) => [traceTurnKey(ref.sessionId, ref.turnId), ref] as const),
    );
    const uniqueRefs = [...refsByKey.values()];
    if (uniqueRefs.length === 0) return [];
    const sessionIds = [...new Set(uniqueRefs.map((ref) => ref.sessionId))];
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

    const totals = totalsRows[0];
    return {
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

  private async getUsageDayRangeTotals(
    dayRanges: ProjectUsageDayRange[],
    sessionScopeFilter: ReturnType<typeof sql>,
  ) {
    if (dayRanges.length === 0) return [];

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
    const rows = await this.db
      .select({ id: romeAgentMessages.id })
      .from(romeAgentMessages)
      .where(and(eq(romeAgentMessages.sessionId, sessionId), eq(romeAgentMessages.turnId, turnId)))
      .limit(1);
    return rows.length > 0;
  }

  /** The rated exchange's visible chat rows (user prompt + assistant reply),
   * excluding trace rows, in insertion order. */
  async getTurnChatMessages(sessionId: string, turnId: string) {
    return this.db
      .select({
        role: romeAgentMessages.role,
        content: romeAgentMessages.content,
      })
      .from(romeAgentMessages)
      .where(
        and(
          eq(romeAgentMessages.sessionId, sessionId),
          eq(romeAgentMessages.turnId, turnId),
          inArray(romeAgentMessages.role, ["user", "assistant"]),
        ),
      )
      .orderBy(asc(romeAgentMessages.createdAt), asc(romeAgentMessages.id));
  }

  async getTraceContentByTurn(sessionId: string, turnId: string) {
    const rows = await this.db
      .select({ id: romeAgentMessages.id, content: romeAgentMessages.content })
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
    return {
      id: stub.id,
      content: mergeTraceContent(stub.content, await this.getTraceBlockContents(stub.id)),
    };
  }

  async getMessageContent(id: string) {
    const rows = await this.db
      .select({ content: romeAgentMessages.content })
      .from(romeAgentMessages)
      .where(eq(romeAgentMessages.id, id));
    const content = rows[0]?.content;
    if (content === undefined) return null;
    // Non-trace messages never have block rows, so the lookup is a no-op
    // for them and the stored content is returned as-is.
    return mergeTraceContent(content, await this.getTraceBlockContents(id));
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

  async deleteMessagesBySession(sessionId: string) {
    // One transaction so trace block rows can't outlive (or orphan) their
    // stub message rows — same crash-safety contract as deleteSession.
    await this.db.transaction((tx) => {
      tx.delete(romeAgentTraceBlocks).where(eq(romeAgentTraceBlocks.sessionId, sessionId)).run();
      tx.delete(romeAgentMessages).where(eq(romeAgentMessages.sessionId, sessionId)).run();
    });
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
