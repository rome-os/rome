// The dashboard's repository over Chats' tables. Vocabulary:
// docs/domains/chats.md and docs/domains/participation.md.
//
// A dashboard chat is a direct message on the `webchat` platform between
// the guardian and the agent's dashboard account, keyed by the id of the
// session that stands in it. Its lines are Chats' messages, linked to the
// turns that took or gave them; a session in no chat, such as a fork or a
// subagent, keeps its own lines, and every session keeps its traces.
//
// Nothing builds it until the Chats switch, which swaps it in for
// WebChatRepository at startup. The contract step folds it into that class.

import { randomUUID } from "node:crypto";
import type { TranscriptPart } from "@rome/api-types/chat";
import type { Account, AgentInputState, ChatId, InputStatusEvent } from "@rome-os/app-runtime";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { CHAT_LINES, CHATS } from "../chats/storage/lines-sql.js";
import { partsText, type SaidBy } from "../chats/storage/message.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import { chatKey, type Place, placeIn } from "../chats/storage/place.js";
import type { DrizzleDb } from "../db/index.js";
import {
  type EnsureRomeSessionInput,
  type MessagePageCursor,
  type MessagePageOptions,
  type StoredWebchatHistoryMessage,
  type StoredWebchatMessage,
  WebChatRepository,
} from "../db/repositories/webchat.js";
import { romeAgentMessages, romeSessions } from "../db/schema.js";
import { isWebchatChat } from "../db/session-kind.js";
import type { SessionActor } from "../lib/session-actor.js";
import { TurnLinks } from "../sessions/turn-links.js";
import type { MessagePart } from "../types.js";

/** The dashboard's platform: Rome's own chat behind the guardian's sign-in. */
export const WEBCHAT_PLATFORM = "webchat";

/** Where a session stands in Chats, and as whom it speaks there. */
interface Standing {
  readonly sessionId: string;
  readonly place: Place;
  readonly accountId: string;
  readonly agent: string;
}

export class ChatsWebChatRepository extends WebChatRepository {
  private readonly chats: ChatRepository;
  private readonly lines: MessageRepository;
  private readonly links: TurnLinks;

  constructor(
    db: DrizzleDb,
    deps: { chats?: ChatRepository; lines?: MessageRepository; links?: TurnLinks } = {},
  ) {
    super(db);
    this.chats = deps.chats ?? new ChatRepository(db);
    this.lines = deps.lines ?? new MessageRepository(db);
    this.links = deps.links ?? new TurnLinks(db, this.lines);
  }

  override async createSession(...args: Parameters<WebChatRepository["createSession"]>) {
    await super.createSession(...args);
    const [id, name, , , , , agentName = null] = args;
    this.startDashboardChat(id, name, agentName);
  }

  override async ensureRomeSession(input: EnsureRomeSessionInput): Promise<void> {
    await super.ensureRomeSession(input);
    const chat =
      input.type === "webchat" || (input.type === "channel" && input.sourceChannel === "webchat");
    if (chat) this.startDashboardChat(input.id, input.name, input.agentName);
  }

  /** A fork made a chat of its own keeps what it said, now said in its new
   *  chat and linked to the turns that said it. */
  override async promoteForkToChat(id: string): Promise<void> {
    const fork = this.db
      .select({ name: romeSessions.name, agentName: romeSessions.agentName })
      .from(romeSessions)
      .where(and(eq(romeSessions.id, id), eq(romeSessions.type, "fork")))
      .get();
    if (!fork) return;
    await super.promoteForkToChat(id);
    this.startDashboardChat(id, fork.name, fork.agentName);
    const standing = this.standingOf(id);
    if (!standing) return;
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
      const recorded = this.lines.record({
        direction: "toRome",
        key: line.id,
        place: standing.place,
        saidBy: fromAgent ? agentSender(standing) : dashboardSender(line.actor ?? undefined),
        body: { text: partsText(parts) },
        parts,
        at: line.createdAt,
      });
      if (line.turnId === null || !recorded) continue;
      if (fromAgent) this.links.answer(recorded.id, id, line.turnId);
      else this.links.prompt(recorded.id, id, line.turnId);
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

  override async recordUserInput(
    id: string,
    sessionId: string,
    content: string,
    actor?: SessionActor,
    saidBy?: Account,
  ): Promise<boolean> {
    const standing = this.standingOf(sessionId);
    if (!standing) return super.recordUserInput(id, sessionId, content, actor, saidBy);
    const parts = partsOf(content);
    const recorded = this.lines.record({
      direction: "toRome",
      key: id,
      place: standing.place,
      saidBy: saidBy
        ? { account: { platform: standing.place.chat.platform, id: saidBy.id } }
        : dashboardSender(actor),
      body: { text: partsText(parts) },
      parts,
      at: new Date(),
    });
    if (!recorded) return false;
    this.links.prompt(recorded.id, sessionId, null, "queued");
    this.advanceActivity(sessionId, recorded.at);
    return true;
  }

  override async recoverInterruptedInputs(): Promise<void> {
    await super.recoverInterruptedInputs();
    // A process crash can occur between the durable dispatch marker and the
    // provider acknowledgement. Preserve the message without replaying it.
    this.links.forgetInputsInFlight();
  }

  override async getUserInput(
    sessionId: string,
    inputId: string,
  ): Promise<{ turnId: string | null; inputState: AgentInputState | null } | undefined> {
    const line = this.lineIn(sessionId, inputId);
    if (line === undefined) return super.getUserInput(sessionId, inputId);
    const link = line === null ? null : this.links.linkOf(sessionId, line);
    return link?.role === "prompt"
      ? { turnId: link.turnId, inputState: link.inputState }
      : undefined;
  }

  override async updateUserInput(sessionId: string, status: InputStatusEvent): Promise<void> {
    const line = this.lineIn(sessionId, status.inputId);
    if (line === undefined) return super.updateUserInput(sessionId, status);
    if (line !== null) this.links.promptRuns(sessionId, line, status.turnId ?? null, status.state);
  }

  /**
   * Add a line to session `sessionId`'s transcript. A user or assistant line
   * of a session that stands in a chat is said there: the guardian's, or the
   * agent's answer to `turnId`. Every other line, and every line of a session
   * that stands in no chat, stays the session's own.
   */
  override async addMessage(
    id: string,
    sessionId: string,
    role: string,
    content: string,
    turnId: string | null = null,
  ) {
    const standing = role === "user" || role === "assistant" ? this.standingOf(sessionId) : null;
    if (!standing) return super.addMessage(id, sessionId, role, content, turnId);
    await this.say(standing, id, role as "user" | "assistant", partsOf(content), turnId);
  }

  protected override async insertBackendMessage(
    sessionId: string,
    turnId: string | null,
    role: string,
    parts: TranscriptPart[],
    id?: string,
  ): Promise<StoredWebchatMessage> {
    const standing = role === "assistant" ? this.standingOf(sessionId) : null;
    if (!standing) return super.insertBackendMessage(sessionId, turnId, role, parts, id);
    const key = id ?? randomUUID();
    const at = await this.say(standing, key, "assistant", parts as MessagePart[], turnId);
    const message: StoredWebchatMessage = {
      id: key,
      sessionId,
      turnId,
      role,
      content: JSON.stringify(parts),
      createdAt: new Date(Math.floor(at.getTime() / 1000) * 1000),
    };
    this.emitMessageInserted(message);
    return message;
  }

  override async getMessages(sessionId: string) {
    return this.selectLines([sessionId]);
  }

  /** The newest `options.limit` turn groups of a session, as
   *  WebChatRepository pages them, over the lines where it stands too. */
  override async getMessagesPage(sessionId: string, options: MessagePageOptions) {
    const before = options.before;
    const groups = this.db.all<{ key: string; startedAt: number }>(sql`
      SELECT key, startedAt FROM (
        SELECT COALESCE(turn_id, id) AS key, MIN(created_at) AS startedAt
        FROM ${sessionLines([sessionId])}
        GROUP BY key
      )
      ${before ? sql`WHERE (startedAt, key) < (${before.startedAt}, ${before.key})` : sql``}
      ORDER BY startedAt DESC, key DESC
      LIMIT ${options.limit + 1}
    `);
    const pageGroups = groups.slice(0, options.limit);
    if (pageGroups.length === 0) return { rows: [], nextCursor: null };
    const keys = JSON.stringify(pageGroups.map((group) => group.key));
    const rows = this.selectLines(
      [sessionId],
      sql`WHERE COALESCE(turn_id, id) IN (SELECT value FROM json_each(${keys}))`,
    );
    const oldest = pageGroups[pageGroups.length - 1];
    return {
      rows,
      nextCursor:
        groups.length > options.limit && oldest
          ? ({ startedAt: oldest.startedAt, key: oldest.key } satisfies MessagePageCursor)
          : null,
    };
  }

  override async getMessagesBatch(sessionIds: string[]) {
    if (sessionIds.length === 0) return [];
    return this.selectLines(sessionIds).map(
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

  override async getMessageCount(sessionId: string) {
    return (
      this.db.all<{ count: number }>(
        sql`SELECT count(*) AS count FROM ${sessionLines([sessionId])}`,
      )[0]?.count ?? 0
    );
  }

  override async getUserMessageActors(sessionId: string): Promise<Map<string, SessionActor>> {
    const rows = this.db.all<LineRow>(sql`
      SELECT * FROM ${sessionLines([sessionId])} WHERE role = 'user'
    `);
    return new Map(
      rows.flatMap((row) => {
        const actor = actorOf(row.sender_id, row.sender_name);
        return actor ? [[row.id, actor] as const] : [];
      }),
    );
  }

  override async getReplyTarget(
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

  override async getHistoryMessages(
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

  override async hasTurnInSession(sessionId: string, turnId: string): Promise<boolean> {
    const rows = this.db.all(sql`
      SELECT 1 FROM rome_agent_messages WHERE session_id = ${sessionId} AND turn_id = ${turnId}
      UNION ALL
      SELECT 1 FROM agent_turn_messages WHERE session_id = ${sessionId} AND turn_id = ${turnId}
      LIMIT 1
    `);
    return rows.length > 0;
  }

  override async getTurnChatMessages(sessionId: string, turnId: string) {
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

  /**
   * Start the dashboard chat session `sessionId` stands in: a direct message
   * between the guardian and the agent's dashboard account, keyed by the
   * session's id. Changes nothing for a session that already has one.
   */
  private startDashboardChat(sessionId: string, name: string, agentName: string | null): void {
    const row = this.db
      .select({ chatId: romeSessions.chatId })
      .from(romeSessions)
      .where(eq(romeSessions.id, sessionId))
      .get();
    if (!row || row.chatId) return;
    const chat = this.chats.start(chatKey(WEBCHAT_PLATFORM, sessionId as ChatId), "dm", name);
    this.db
      .update(romeSessions)
      .set({
        chatId: chat.ref.id,
        chatPlatform: chat.ref.platform,
        accountId: dashboardAccountId(agentName),
      })
      .where(eq(romeSessions.id, sessionId))
      .run();
  }

  /** Where session `sessionId` stands in Chats, or null for a session in no
   *  chat. */
  private standingOf(sessionId: string): Standing | null {
    const row = this.db
      .select({
        chatId: romeSessions.chatId,
        threadId: romeSessions.threadId,
        accountId: romeSessions.accountId,
        agentName: romeSessions.agentName,
      })
      .from(romeSessions)
      .where(eq(romeSessions.id, sessionId))
      .get();
    const chat = row?.chatId ? this.chats.find(row.chatId) : null;
    if (!row || !chat) return null;
    return {
      sessionId,
      place: placeIn(chat.ref, row.threadId === null ? undefined : (row.threadId as ChatId)),
      accountId: row.accountId ?? chat.ref.platform,
      agent: row.agentName ?? "main",
    };
  }

  /** The id of the line keyed `key` where session `sessionId` stands, null
   *  when Rome holds none there, or undefined for a session in no chat. */
  private lineIn(sessionId: string, key: string): number | null | undefined {
    const standing = this.standingOf(sessionId);
    return standing ? this.lines.idOf(standing.place.chat, key) : undefined;
  }

  private advanceActivity(sessionId: string, at: Date): void {
    const seconds = Math.floor(at.getTime() / 1000);
    this.db
      .update(romeSessions)
      .set({
        activityAt: sql`case when ${romeSessions.activityAt} < ${seconds} then ${seconds} else ${romeSessions.activityAt} end`,
      })
      .where(eq(romeSessions.id, sessionId))
      .run();
  }

  /** Say a dashboard line where `standing` is, linked to `turnId`. Rome is
   *  the platform, so a line is delivered once it is recorded. */
  private async say(
    standing: Standing,
    key: string,
    role: "user" | "assistant",
    parts: MessagePart[],
    turnId: string | null,
  ): Promise<Date> {
    const at = new Date();
    if (role === "user") {
      const recorded = this.lines.record({
        direction: "toRome",
        key,
        place: standing.place,
        saidBy: dashboardSender(undefined),
        body: { text: partsText(parts) },
        parts,
        at,
      });
      if (recorded && turnId) this.links.prompt(recorded.id, standing.sessionId, turnId);
    } else {
      const sent = await this.lines.send(
        { direction: "fromRome", place: standing.place, saidBy: agentSender(standing), parts },
        // The dashboard adapter keys its line, and the client knows it by
        // that key already.
        async () => ({ key }),
      );
      if (sent.id !== null && turnId) this.links.answer(sent.id, standing.sessionId, turnId);
    }
    this.advanceActivity(standing.sessionId, at);
    return at;
  }

  private selectLines(sessionIds: readonly string[], where: SQL = sql``): TranscriptLine[] {
    // Partitioning by turn keeps a turn's user, assistant and trace lines
    // contiguous even when a later turn's prompt was said before an earlier
    // turn's reply.
    return this.db
      .all<LineRow>(sql`
        SELECT * FROM ${sessionLines(sessionIds)}
        ${where}
        ORDER BY session_id,
          MIN(created_at) OVER (PARTITION BY session_id, COALESCE(turn_id, id)),
          turn_id, created_at, line_order, seq
      `)
      .map(storedLine);
  }
}

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

/** The agent's dashboard account where `standing` is, as the sender of its
 *  lines. */
function agentSender(standing: Standing): SaidBy & { agent: string } {
  return {
    account: { platform: standing.place.chat.platform, id: standing.accountId },
    agent: standing.agent,
  };
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
  input_state: AgentInputState | null;
  role: string;
  content: string;
  created_at: number;
  sender_id: string | null;
  sender_name: string | null;
  line_order: number;
  seq: number;
}

/** A transcript line as WebChatRepository reads it, with where its input
 *  stands. */
type TranscriptLine = StoredWebchatMessage & { inputState: AgentInputState | null };

function storedLine(row: LineRow): TranscriptLine {
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
 * session's own lines (traces, and the lines of a session that stands in no
 * chat). A line is the session's prompt or answer by its turn link; a line
 * with none is its agent's when its account said it, the guardian's on the
 * dashboard, and a notification elsewhere. `line_order` puts a prompt before
 * the trace and answer of its turn within one second.
 */
export function sessionLines(sessionIds: readonly string[]) {
  const ids = JSON.stringify(sessionIds);
  return sql`(
    SELECT m.key AS id, s.id AS session_id,
      -- A line the turn only caught up on is no part of the turn.
      CASE WHEN l.role IN ('prompt', 'answer') THEN l.turn_id END AS turn_id, l.input_state,
      CASE WHEN l.role = 'answer'
             OR (l.role IS NULL AND m.sender_agent IS NOT NULL AND m.sender_account_id IS s.account_id)
             THEN 'assistant'
           WHEN l.role = 'prompt' OR c.platform = ${WEBCHAT_PLATFORM} THEN 'user'
           ELSE 'notification' END AS role,
      m.parts AS content, m.said_at AS created_at, m.sender_account_id AS sender_id,
      m.sender_name,
      CASE WHEN l.role = 'prompt' OR (l.role IS NULL AND m.sender_agent IS NULL) THEN 0 ELSE 2 END
        AS line_order,
      m.seq AS seq
    FROM rome_sessions s
    JOIN ${CHATS} c ON c.id = s.chat_id
    JOIN ${CHAT_LINES} m ON m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
      -- A session sees the place from when it started there.
      AND m.said_at >= s.created_at
    LEFT JOIN agent_turn_messages l ON l.message_id = m.id AND l.session_id = s.id
    WHERE s.id IN (SELECT value FROM json_each(${ids}))
    UNION ALL
    SELECT r.id, r.session_id, r.turn_id, r.input_state, r.role,
      CASE WHEN r.role = 'trace' THEN '[]' ELSE r.content END AS content,
      r.created_at,
      CASE json_extract(r.actor, '$.kind') WHEN 'guardian' THEN 'guardian'
        WHEN 'visitor' THEN 'visitor:' || json_extract(r.actor, '$.accountId') END AS sender_id,
      json_extract(r.actor, '$.email') AS sender_name,
      CASE WHEN r.role = 'user' THEN 0 WHEN r.role = 'trace' THEN 1 ELSE 2 END AS line_order,
      r.rowid AS seq
    FROM rome_agent_messages r JOIN rome_sessions s ON s.id = r.session_id
    WHERE r.session_id IN (SELECT value FROM json_each(${ids}))
      AND (s.chat_id IS NULL OR r.role NOT IN ('user', 'assistant', 'notification'))
  )`;
}
