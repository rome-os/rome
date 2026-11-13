import { automatedSource, speaksForGuardian } from "./automated-source.js";
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
import type {
  Account,
  AgentInputState,
  AgentTurnFailure,
  ChatId,
  InputStatusEvent,
} from "@rome-os/app-runtime";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { CHAT_MESSAGES, CHATS } from "../chats/storage/messages-sql.js";
import { partsText, type SaidBy } from "../chats/storage/message.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import { type ChatRef, chatKey, type Place, placeIn } from "../chats/storage/place.js";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import type { SessionRecords } from "../sessions/session-records.js";
import {
  type ChatThreadPlacement,
  type EnsureRomeSessionInput,
  type InterruptedTurn,
  type MessagePageCursor,
  type MessagePageOptions,
  type StoredWebchatHistoryMessage,
  type StoredWebchatMessage,
  type TraceBatch,
  WebChatRepository,
} from "./repository.js";
import {
  agentTurnMessages,
  romeAgentMessages,
  romeAgentTraceBlocks,
  romeSessions,
  sessions,
} from "../db/schema.js";
import { isWebchatChat, storedSessionType } from "../db/session-kind.js";
import type { SessionActor } from "../access/session-actor.js";
import { TurnLinks } from "../sessions/turn-links.js";
import {
  ChatReadModel,
  chatsSessionAwaitingGuardian,
  chatsSessionOpenCards,
  chatsSessionInteractions,
  chatsSessionOwnerSpokeAt,
} from "./chat-read-model.js";
import {
  isSessionTraceArchived,
  sessionTraceCutoff,
  TRACE_ACTIVITY_ROLES,
} from "./trace-retention.js";
import type { MessagePart } from "../types.js";

/** The dashboard's platform: Rome's own chat behind the guardian's sign-in. */
export const WEBCHAT_PLATFORM = "webchat";

/** A turn that ended in an error, as its trace records the error. */
export interface ErroredTurn {
  turn: InterruptedTurn;
  /** The error block's own fields. The block names its provider only when a resolution error wrote it. */
  failure: Pick<
    AgentTurnFailure,
    "message" | "code" | "reason" | "httpStatus" | "providerError"
  > & {
    provider?: string;
  };
  /** The provider in the model pin of the runtime session that resumes the chat, null before a turn completed in it. */
  pinnedProvider: string | null;
}

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
  private readonly reads: ChatReadModel;

  constructor(
    db: DrizzleDb,
    deps: {
      chats?: ChatRepository;
      lines?: MessageRepository;
      links?: TurnLinks;
      records?: SessionRecords;
    } = {},
  ) {
    super(db, deps.records);
    this.chats = deps.chats ?? new ChatRepository(db);
    this.lines = deps.lines ?? new MessageRepository(db);
    this.links = deps.links ?? new TurnLinks(db, this.lines);
    this.reads = new ChatReadModel(db, { messages: this.lines, links: this.links });
  }

  // A listed session counts and waits on the lines its transcript draws.
  protected override readonly messageCountColumn = chatsSessionMessageCount;
  protected override readonly awaitingGuardianColumn = chatsSessionAwaitingGuardian;
  protected override readonly openCardsColumn = chatsSessionOpenCards;
  protected override readonly interactionsColumn = chatsSessionInteractions;
  protected override readonly ownerSpokeAtColumn = chatsSessionOwnerSpokeAt;

  /** Searches the dashboard chats' messages in Chats, at most one match per
   *  chat, the most recent, most recent first. A dashboard notice is not in
   *  Chats yet (#1672), so search, like the transcript, leaves it out. */
  override async searchSessionMessages(
    query: string,
    options: { sessionLimit?: number; visibleTo?: string | null } = {},
  ) {
    return this.searchChats(query, Math.max(1, options.sessionLimit ?? 20), options.visibleTo);
  }

  /** The dashboard chats' messages in Chats that match `query`, at most one
   *  per chat, most recent first. */
  private async searchChats(query: string, limit: number, visibleTo?: string | null) {
    const hits = await this.reads.search(query, limit, visibleTo);
    if (hits.length === 0) return [];
    const sessions = new Map(
      (
        await this.db
          .select(this.sessionFields())
          .from(romeSessions)
          .where(
            and(
              inArray(
                romeSessions.id,
                hits.map((hit) => hit.chatId),
              ),
              isWebchatChat,
            ),
          )
      ).map((session) => [session.id, session]),
    );
    return hits.flatMap((hit) => {
      const session = sessions.get(hit.chatId);
      if (!session) return [];
      return [
        {
          session,
          message: {
            id: hit.messageId,
            role: hit.role,
            createdAt: hit.createdAt,
            snippet: hit.snippet,
          },
        },
      ];
    });
  }

  /** How many lines from Rome the session's chat got since the guardian
   *  last read it, counting at most `cap`. */
  override async countUnreadAgentMessages(id: string, cap: number): Promise<number> {
    return await this.reads.unreadCount(id, cap);
  }

  override async createSession(...args: Parameters<WebChatRepository["createSession"]>) {
    await super.createSession(...args);
    const [id, name, , , , , agentName = null, type = "webchat"] = args;
    // A handoff stays its own conversation, outside Chats.
    if (type === "webchat") this.startDashboardChat(id, name, agentName);
  }

  override async ensureRomeSession(input: EnsureRomeSessionInput): Promise<void> {
    await super.ensureRomeSession(input);
    const chat =
      input.type === "webchat" || (input.type === "channel" && input.sourceChannel === "webchat");
    if (chat) this.startDashboardChat(input.id, input.name, input.agentName);
  }

  /**
   * A fork made a chat of its own keeps what it said, now said in its new
   * chat and linked to the turns that said it. It becomes a chat, gets its
   * chat and moves its lines in one transaction, so a failure leaves it a
   * fork, and promoting it again starts over.
   */
  override async promoteForkToChat(id: string): Promise<void> {
    this.db.transaction(() => {
      const fork = this.db
        .select({ name: romeSessions.name, agentName: romeSessions.agentName })
        .from(romeSessions)
        .where(and(eq(romeSessions.id, id), eq(romeSessions.type, "fork")))
        .get();
      if (!fork) return;
      // As WebChatRepository promotes it: an ordinary chat at its own
      // address, its unread clock started.
      this.db
        .update(romeSessions)
        .set({
          type: storedSessionType("webchat"),
          sourceChannel: "webchat",
          sourceThreadId: sql`${romeSessions.id}`,
          lastSeenActivityAt: sql`${romeSessions.activityAt}`,
        })
        .where(eq(romeSessions.id, id))
        .run();
      this.startDashboardChat(id, fork.name, fork.agentName);
      const standing = this.standingOf(id);
      if (!standing) throw new Error(`Promoted fork ${id} stands in no chat`);
      const said = this.db
        .select({
          id: romeAgentMessages.id,
          turnId: romeAgentMessages.turnId,
          role: romeAgentMessages.role,
          content: romeAgentMessages.content,
          actor: romeAgentMessages.actor,
          inputState: romeAgentMessages.inputState,
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
        const lineId = recorded?.id ?? this.lines.idOf(standing.place.chat, line.id);
        if (lineId === null) throw new Error(`Line ${line.id} could not be moved`);
        // Every input stays one the session can admit, queued or run, with
        // where it stands.
        if (!fromAgent) this.links.prompt(lineId, id, line.turnId, line.inputState);
        else if (line.turnId !== null) this.links.answer(lineId, id, line.turnId);
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
    });
  }

  /**
   * Write a turn's trace batch. The prompt and answer it carries are said in
   * the chat of a session that stands in one, such as a fork promoted while
   * its turn ran, in the same transaction as the trace, which stays the
   * session's own: a batch whose answer could not be said leaves nothing
   * behind, so the recorder's place in the trace stays true.
   */
  protected override writeTraceBatch(input: TraceBatch, now = new Date()): void {
    const said = input.transcriptMessages ?? [];
    const inChat = said.flatMap((message) => {
      const standing = this.standingOf(message.sessionId);
      return standing ? [{ message, standing }] : [];
    });
    if (inChat.length === 0) return super.writeTraceBatch(input, now);
    const own = said.filter((message) => !inChat.some((line) => line.message === message));
    // Prompt, trace, answer, at the times the base class gives them.
    const sayAll = (role: "user" | "assistant", at: Date) => {
      for (const { message, standing } of inChat) {
        if (message.role !== role) continue;
        this.say(
          standing,
          message.id,
          role,
          partsOf(message.content),
          message.turnId,
          undefined,
          at,
        );
      }
    };
    this.db.transaction(() => {
      sayAll("user", now);
      super.writeTraceBatch({ ...input, transcriptMessages: own }, now);
      sayAll("assistant", new Date(now.getTime() + 2));
    });
  }

  /**
   * The sessions among `sessionIds` whose traces are archived, as
   * WebChatRepository decides, counting the lines said where each session
   * or an ancestor stands as its activity too.
   */
  override async getTraceArchivedSessionIds(
    sessionIds: readonly string[],
    cutoff = sessionTraceCutoff(),
  ): Promise<string[]> {
    if (sessionIds.length === 0) return [];
    const ids = JSON.stringify([...new Set(sessionIds)]);
    const roles = JSON.stringify(TRACE_ACTIVITY_ROLES);
    const rows = this.db.all<{ sessionId: string; lastMessageAt: number }>(sql`
      WITH RECURSIVE ancestors(session_id, ancestor_id, parent_id) AS (
        SELECT id, id, parent_session_id FROM rome_sessions
        WHERE id IN (SELECT value FROM json_each(${ids}))
        UNION
        SELECT ancestors.session_id, parent.id, parent.parent_session_id
        FROM ancestors JOIN rome_sessions AS parent ON parent.id = ancestors.parent_id
      ),
      activity AS MATERIALIZED (
        SELECT session_id, max(created_at) AS last_message_at FROM rome_agent_messages
        WHERE session_id IN (SELECT ancestor_id FROM ancestors)
          AND role IN (SELECT value FROM json_each(${roles}))
        GROUP BY session_id
        UNION ALL
        SELECT s.id, max(m.said_at) FROM rome_sessions s
        JOIN chat_messages m ON m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
          AND m.said_at >= s.created_at
        WHERE s.id IN (SELECT ancestor_id FROM ancestors)
        GROUP BY s.id
      )
      SELECT ancestors.session_id AS sessionId, max(activity.last_message_at) AS lastMessageAt
      FROM ancestors JOIN activity ON activity.session_id = ancestors.ancestor_id
      GROUP BY ancestors.session_id
    `);
    return rows
      .filter((row) => isSessionTraceArchived(new Date(row.lastMessageAt * 1000), cutoff))
      .map((row) => row.sessionId);
  }

  override async recordUserInput(
    id: string,
    sessionId: string,
    content: string,
    actor?: SessionActor,
    saidBy?: Account,
    chatThread?: ChatThreadPlacement,
  ): Promise<boolean> {
    const standing = this.standingOf(sessionId);
    if (!standing) return super.recordUserInput(id, sessionId, content, actor, saidBy);
    const parts = partsOf(content);
    // The input, its queued link and the session's activity commit together,
    // so an input on record is always one the session can admit.
    let root: string | null = null;
    const recorded = this.db.transaction(() => {
      const recorded = this.lines.record({
        direction: "toRome",
        key: id,
        place: standing.place,
        // A tagged source records the chain kind; an agent speaking for the guardian uses their account.
        saidBy: saidBy
          ? {
              account: {
                platform: WEBCHAT_PLATFORM,
                id: saidBy.id.startsWith("automated::")
                  ? saidBy.id
                  : speaksForGuardian({ type: "agent", id: saidBy.id }, actor?.kind)
                    ? "guardian"
                    : dashboardAccountId(saidBy.id),
              },
              ...(saidBy.id.startsWith("automated::") ? {} : { agent: saidBy.id }),
            }
          : dashboardSender(actor),
        body: { text: partsText(parts) },
        parts,
        at: new Date(),
      });
      if (!recorded) return false;
      if (chatThread) root = this.place(standing, id, chatThread).rooted;
      this.links.prompt(recorded.id, sessionId, null, "queued");
      this.advanceActivity(sessionId, recorded.at);
      return true;
    });
    this.emitRooted(sessionId, root);
    const thread = recorded && chatThread ? this.lines.chatThreadOf(standing.place.chat, id) : null;
    if (thread) this.emitChatThreadPlaced({ sessionId, messageId: id, chatThreadId: thread });
    return recorded;
  }

  override async placeInChatThread(
    sessionId: string,
    messageId: string,
    placement: ChatThreadPlacement,
  ): Promise<string | null> {
    const standing = this.standingOf(sessionId);
    if (!standing || this.lines.idOf(standing.place.chat, messageId) === null) return null;
    const { placed, rooted } = this.db.transaction(() =>
      this.place(standing, messageId, placement),
    );
    this.emitRooted(sessionId, rooted);
    const thread = this.lines.chatThreadOf(standing.place.chat, messageId);
    if (placed && thread) this.emitChatThreadPlaced({ sessionId, messageId, chatThreadId: thread });
    return thread;
  }

  override async chatThreadOf(sessionId: string, messageId: string): Promise<string | null> {
    const standing = this.standingOf(sessionId);
    return standing ? this.lines.chatThreadOf(standing.place.chat, messageId) : null;
  }

  override async getChatThreadMessages(
    sessionId: string,
    messageId: string,
  ): Promise<TranscriptLine[]> {
    const standing = this.standingOf(sessionId);
    const thread = standing ? this.lines.chatThreadOf(standing.place.chat, messageId) : null;
    if (!thread) return [];
    return this.selectLines([sessionId], sql`WHERE role IN ('user', 'assistant')`, thread);
  }

  /**
   * Put the line keyed `key` where `standing` is in the chat thread
   * `placement` names. Answers whether it was placed. Runs inside the
   * caller's transaction when there is one.
   */
  private place(
    standing: Standing,
    key: string,
    placement: ChatThreadPlacement,
  ): { placed: boolean; rooted: string | null } {
    const chat = standing.place.chat;
    const thread = "in" in placement ? (this.lines.chatThreadOf(chat, placement.in) ?? key) : key;
    // A message in no thread that a reply joins becomes its thread's root, so
    // whether a message is in a thread has one answer.
    const rooted =
      "in" in placement && thread === placement.in && thread !== key
        ? this.lines.rootChatThread(chat, thread)
        : false;
    const placed = this.lines.placeInChatThread(chat, key, thread, {
      settle: placement.settle === true,
    });
    return { placed, rooted: rooted ? thread : null };
  }

  /** Tells the chat's listeners that `root` now starts its own thread. */
  private emitRooted(sessionId: string, root: string | null): void {
    if (root) this.emitChatThreadPlaced({ sessionId, messageId: root, chatThreadId: root });
  }

  /** Rechecked at dispatch: only an unchanged guardian root chat can continue. */
  canContinueAfterRestart(turn: InterruptedTurn): boolean {
    return (
      this.db.get<{ eligible: number }>(sql`
      SELECT 1 AS eligible
      FROM ${romeSessions} s
      JOIN ${CHATS} c ON c.id = s.chat_id AND c.platform = 'webchat'
      JOIN ${romeAgentMessages} t ON t.id = ${turn.messageId} AND t.session_id = s.id
      WHERE s.id = ${turn.sessionId} AND s.type = 'channel' AND s.chat_platform = 'webchat'
        AND (s.owner_key IS NULL OR s.owner_key = 'guardian')
        AND s.parent_session_id IS NULL AND s.parent_turn_id IS NULL
        AND s.archived_at IS NULL AND s.trigger_kind IS NULL AND t.trigger_kind IS NULL
        AND EXISTS (
          SELECT 1 FROM agent_turn_messages l
          JOIN ${CHAT_MESSAGES} m ON m.id = l.message_id
          WHERE l.session_id = s.id AND l.turn_id = ${turn.turnId} AND l.role = 'prompt'
            AND m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
            AND m.sender_account_id = 'guardian' AND m.sender_agent IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${CHAT_MESSAGES} m
          WHERE m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
            AND m.sender_account_id = 'guardian' AND m.sender_agent IS NULL
            AND m.id > (
              SELECT min(l.message_id) FROM agent_turn_messages l
              WHERE l.session_id = s.id AND l.turn_id = ${turn.turnId} AND l.role = 'prompt'
            )
            AND NOT EXISTS (
              SELECT 1 FROM agent_turn_messages l2
              WHERE l2.message_id = m.id AND l2.session_id = s.id
                AND l2.turn_id = ${turn.turnId} AND l2.role = 'prompt'
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${romeAgentMessages} n
          WHERE n.session_id = s.id AND n.role = 'trace' AND n.id <> t.id
            AND (n.created_at > t.created_at OR (n.created_at = t.created_at AND n.rowid > t.rowid))
        )
    `)?.eligible === 1
    );
  }

  /** Latest timestamped evidence for this turn, in milliseconds, or null. Not a heartbeat or exact restart time. */
  getRestartLastActivityAt(turn: InterruptedTurn): number | null {
    // Trace blocks have no timestamp column, and a trace has no updated_at.
    // Runtime sessions are touched on each non-transient model block. The
    // other signals cover legacy sessions and preserve event-time precision.
    // None count the cleanup's synthetic ending as activity.
    const rows = this.db.all<{ at: number | string | null }>(sql`
      SELECT created_at AS at FROM ${romeAgentMessages}
      WHERE id = ${turn.messageId} AND session_id = ${turn.sessionId} AND role = 'trace'
      UNION ALL
      SELECT last_active_at FROM ${sessions} WHERE id = ${turn.runtimeSessionId}
      UNION ALL
      SELECT m.said_at FROM agent_turn_messages l
      JOIN ${romeSessions} s ON s.id = l.session_id
      JOIN ${CHAT_MESSAGES} m ON m.id = l.message_id
        AND m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
      WHERE l.session_id = ${turn.sessionId} AND l.turn_id = ${turn.turnId}
        AND l.role IN ('prompt', 'answer')
      UNION ALL
      SELECT coalesce(json_extract(b.content, '$.endedAt'), json_extract(b.content, '$.startedAt'))
      FROM ${romeAgentTraceBlocks} b
      WHERE b.message_id = ${turn.messageId}
        AND json_extract(b.content, '$.type') IN ('tool_use', 'tool_result', 'subagent_start', 'subagent_result')
        AND b.seq > (
          SELECT max(seq) FROM ${romeAgentTraceBlocks}
          WHERE message_id = ${turn.messageId} AND json_extract(content, '$.type') = 'turn_start'
        )
    `);
    let latest: number | null = null;
    for (const { at } of rows) {
      const timestamp =
        typeof at === "number" ? at * 1000 : typeof at === "string" ? Date.parse(at) : NaN;
      if (Number.isFinite(timestamp))
        latest = latest === null ? timestamp : Math.max(latest, timestamp);
    }
    return latest;
  }

  /** At most 1000 characters of this turn's guardian prompt lines, in chat order. Empty when none exist. */
  getRestartGuardianPrompt(turn: InterruptedTurn): string {
    return this.db
      .all<{ text: string }>(sql`
      SELECT m.text
      FROM agent_turn_messages l
      JOIN ${romeSessions} s ON s.id = l.session_id
      JOIN ${CHAT_MESSAGES} m ON m.id = l.message_id
        AND m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
      WHERE l.session_id = ${turn.sessionId} AND l.turn_id = ${turn.turnId} AND l.role = 'prompt'
        AND m.sender_account_id = 'guardian' AND m.sender_agent IS NULL
      ORDER BY m.id
    `)
      .map((row) => row.text)
      .join("\n\n")
      .slice(0, 1000);
  }

  /**
   * Who wrote the messages that started `turn`, by the account each records
   * ("guardian", "visitor:<account>"), each once. More than one means the
   * turn held more than one person's input. An agent's message names no one.
   */
  getTurnPromptSenders(turn: Pick<InterruptedTurn, "sessionId" | "turnId">): string[] {
    return this.db
      .all<{ sender: string }>(sql`
      SELECT DISTINCT m.sender_account_id AS sender
      FROM agent_turn_messages l
      JOIN ${romeSessions} s ON s.id = l.session_id
      JOIN ${CHAT_MESSAGES} m ON m.id = l.message_id
        AND m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
      WHERE l.session_id = ${turn.sessionId} AND l.turn_id = ${turn.turnId} AND l.role = 'prompt'
        AND m.sender_agent IS NULL AND m.sender_account_id IS NOT NULL
    `)
      .map((row) => row.sender);
  }

  /**
   * The newest turn of each dashboard chat that ended in an error, when its
   * trace began at or after `sinceMs` or its runtime session was active then.
   * A turn that began earlier and was active since is listed, and the caller
   * decides by its last activity. A turn still running, or ended any other
   * way, is not listed. A Concierge chat is listed like any other: when it moved
   * to another provider on its own, its recovery turn is its newest turn, and
   * when it could not move, its stopped turn still is. Oldest first.
   * Eligibility is for `canContinueAfterRestart` to decide.
   */
  getLatestErroredTurns(sinceMs: number): ErroredTurn[] {
    const since = Math.floor(sinceMs / 1000);
    // One index probe per chat finds its newest trace, so the work follows the
    // number of chats and only a chat with recent activity has its blocks read.
    const traces = this.db.all<{
      messageId: string;
      sessionId: string;
      turnId: string | null;
      agentName: string | null;
    }>(sql`
      SELECT t.id AS messageId, t.session_id AS sessionId, t.turn_id AS turnId, s.agent_name AS agentName
      FROM ${romeSessions} s
      JOIN ${romeAgentMessages} t ON t.id = (
        SELECT n.id FROM ${romeAgentMessages} n
        WHERE n.session_id = s.id AND n.role = 'trace'
        ORDER BY n.created_at DESC, n.rowid DESC LIMIT 1
      )
      WHERE s.type = 'channel' AND s.chat_platform = 'webchat'
        AND (
          t.created_at >= ${since}
          OR EXISTS (SELECT 1 FROM ${sessions} r WHERE r.chat_id = s.id AND r.last_active_at >= ${since})
        )
      ORDER BY t.created_at, t.rowid
    `);
    const errored: ErroredTurn[] = [];
    for (const trace of traces) {
      const blocks = this.db
        .all<{ content: string }>(sql`
          SELECT content FROM ${romeAgentTraceBlocks}
          WHERE message_id = ${trace.messageId}
            AND json_extract(content, '$.type') IN ('turn_start', 'error', 'turn_end')
          ORDER BY seq
        `)
        .flatMap(({ content }) => {
          try {
            return [JSON.parse(content) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
      const newestFirst = blocks.slice().reverse();
      const begun = newestFirst.find((block) => block.type === "turn_start");
      if (!begun) continue;
      const after = newestFirst.slice(0, newestFirst.indexOf(begun));
      const error = after.find((block) => block.type === "error");
      const end = after.find((block) => block.type === "turn_end");
      if (!error || end?.status !== "error" || typeof error.error !== "string") continue;
      // A turn the dashboard refused before any model session opened names the
      // chat in `turn_start`, not a runtime. Either way, the chat's active runtime resumes it.
      const named = typeof begun.sessionId === "string" ? begun.sessionId : "";
      const runtime = this.db.get<{ id: string; provider: string | null }>(sql`
        SELECT id, provider FROM ${sessions}
        WHERE status = 'active' AND channel_thread_key IS NOT NULL
          AND (id = ${named} OR chat_id = ${trace.sessionId})
        ORDER BY id = ${named} DESC, last_active_at DESC
        LIMIT 1
      `);
      const text = (value: unknown) => (typeof value === "string" ? value : undefined);
      errored.push({
        turn: {
          agentName: trace.agentName ?? text(begun.agent) ?? "main",
          messageId: trace.messageId,
          sessionId: trace.sessionId,
          turnId: text(begun.turnId) ?? trace.turnId ?? "",
          runtimeSessionId: runtime?.id ?? null,
          prompt: text(begun.userPrompt) ?? "",
        },
        failure: {
          message: error.error,
          provider: text(error.provider),
          code: text(error.code) as AgentTurnFailure["code"],
          reason: text(error.reason) as AgentTurnFailure["reason"],
          httpStatus: typeof error.httpStatus === "number" ? error.httpStatus : undefined,
          providerError: text(error.providerError),
        },
        pinnedProvider: runtime?.provider ?? null,
      });
    }
    return errored;
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
    this.say(standing, id, role as "user" | "assistant", partsOf(content), turnId);
  }

  protected override async insertBackendMessage(
    sessionId: string,
    turnId: string | null,
    role: string,
    parts: TranscriptPart[],
    id?: string,
    chatThread?: ChatThreadPlacement,
  ): Promise<StoredWebchatMessage> {
    const standing = role === "assistant" ? this.standingOf(sessionId) : null;
    if (!standing) return super.insertBackendMessage(sessionId, turnId, role, parts, id);
    const key = id ?? randomUUID();
    const at = this.say(standing, key, "assistant", parts as MessagePart[], turnId, chatThread);
    const message: StoredWebchatMessage = {
      id: key,
      sessionId,
      turnId,
      role,
      content: JSON.stringify(parts),
      ...(chatThread ? { chatThreadId: this.lines.chatThreadOf(standing.place.chat, key) } : {}),
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

  override async getUserMessageSources(sessionId: string): Promise<Map<string, string>> {
    const rows = this.db.all<LineRow>(
      sql`SELECT * FROM ${sessionLines([sessionId])} WHERE role = 'user'`,
    );
    return new Map(
      rows.flatMap((row) =>
        row.source_id && automatedSource(row.source_id) ? [[row.id, row.source_id] as const] : [],
      ),
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
      senderId: row.source_id,
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
          l.session_id, COALESCE(l.turn_id, l.id), l.created_at, l.line_order, l.seq
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
        senderId: row.turn_sender_id,
        // `queued` for an input linked to the turn that has not reached it:
        // a later turn takes it.
        inputState: row.input_state,
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

  /**
   * Delete sessions `ids` with the dashboard chats they stand in, each with
   * every line said in it. A chat is the session's alone when it is the
   * dashboard chat keyed by that session; a channel chat goes on without it,
   * and without the sessions' links to its messages.
   */
  protected override deleteSessionRows(tx: DrizzleTx, ids: string[]): void {
    const ended = ids.flatMap((id) => this.dashboardChatOf(id) ?? []);
    tx.delete(agentTurnMessages).where(inArray(agentTurnMessages.sessionId, ids)).run();
    super.deleteSessionRows(tx, ids);
    for (const ref of ended) this.chats.end(ref);
  }

  /** Name session `id` and its dashboard chat `name` in one transaction. */
  protected override async renameSession(
    id: string,
    name: string,
    currentName?: string,
  ): Promise<boolean> {
    return this.db.transaction((tx) => {
      const renamed =
        tx
          .update(romeSessions)
          .set({ name })
          .where(
            and(
              eq(romeSessions.id, id),
              currentName === undefined ? undefined : eq(romeSessions.name, currentName),
            ),
          )
          .returning({ id: romeSessions.id })
          .all().length > 0;
      const chat = renamed ? this.dashboardChatOf(id) : null;
      if (chat) this.chats.rename(chat, name);
      return renamed;
    });
  }

  /** The dashboard chat keyed by session `sessionId`, or null when the
   *  session stands in none. */
  private dashboardChatOf(sessionId: string): ChatRef | null {
    const row = this.db
      .select({ chatId: romeSessions.chatId })
      .from(romeSessions)
      .where(eq(romeSessions.id, sessionId))
      .get();
    const chat = row?.chatId ? this.chats.find(row.chatId) : null;
    return chat?.ref.platform === WEBCHAT_PLATFORM && chat.key === sessionId ? chat.ref : null;
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

  /**
   * Say a dashboard line where `standing` is, linked to `turnId`, in one
   * transaction. Rome is the platform, so a line is said once it is
   * recorded. Saying it again, as a retry does, changes nothing but a
   * missing link.
   */
  private say(
    standing: Standing,
    key: string,
    role: "user" | "assistant",
    parts: MessagePart[],
    turnId: string | null,
    chatThread?: ChatThreadPlacement,
    at: Date = new Date(),
  ): Date {
    let root: string | null = null;
    this.db.transaction(() => {
      const recorded = this.lines.record({
        direction: "toRome",
        key,
        place: standing.place,
        saidBy: role === "user" ? dashboardSender(undefined) : agentSender(standing),
        body: { text: partsText(parts) },
        parts,
        at,
      });
      const id = recorded?.id ?? this.lines.idOf(standing.place.chat, key);
      if (id === null) throw new Error(`Dashboard line ${key} could not be recorded`);
      if (chatThread) root = this.place(standing, key, chatThread).rooted;
      if (turnId && role === "user") this.links.prompt(id, standing.sessionId, turnId);
      if (turnId && role === "assistant") this.links.answer(id, standing.sessionId, turnId);
      this.advanceActivity(standing.sessionId, at);
    });
    this.emitRooted(standing.sessionId, root);
    return at;
  }

  private selectLines(
    sessionIds: readonly string[],
    where: SQL = sql``,
    chatThread?: string,
  ): TranscriptLine[] {
    // Partitioning by turn keeps a turn's user, assistant and trace lines
    // contiguous even when a later turn's prompt was said before an earlier
    // turn's reply. A chat thread reads in the order its lines were said.
    const order =
      chatThread === undefined
        ? sql`ORDER BY session_id,
          MIN(created_at) OVER (PARTITION BY session_id, COALESCE(turn_id, id)),
          turn_id, created_at, line_order, seq`
        : sql`ORDER BY created_at, seq`;
    return this.db
      .all<LineRow>(sql`
        SELECT * FROM ${sessionLines(sessionIds, chatThread)}
        ${where}
        ${order}
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
  if (senderId?.startsWith("automated::"))
    return { kind: "guardian", userId: "guardian", via: "loopback" };
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
  /** Who said it, as WebChatRepository names the sender of a turn's line:
   *  the agent for a line an agent said. */
  turn_sender_id: string | null;
  source_id: string | null;
  chat_thread_id: string | null;
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
    chatThreadId: row.chat_thread_id,
    createdAt: new Date(row.created_at * 1000),
  };
}

/**
 * The transcript lines of `sessionIds`, as one table: what was said where
 * each session stands, from Chats, beside the session's traces, and the
 * own rows of a session that stands in no chat. Every message recorded
 * there is a line, so each of Rome's accounts' copies in a Telegram basic
 * group is one (#1670), and a dashboard notice is not a line (#1672). A line is the session's prompt or answer by its turn link; a line
 * with none, or only caught up on, is its agent's when its account said it,
 * the guardian's on the dashboard, and a notification elsewhere.
 * Lines keep the order they were said in; within one second, `line_order`
 * puts a turn's first prompt before its trace, and the trace before the
 * turn's other lines.
 */
export function sessionLines(sessionIds: readonly string[], chatThread?: string) {
  const ids = JSON.stringify(sessionIds);
  return sql`(
    SELECT m.key AS id, s.id AS session_id,
      l.turn_id, l.input_state,
      CASE WHEN l.role = 'answer'
             OR (l.role IS NULL AND m.sender_agent IS NOT NULL AND m.sender_account_id IS s.account_id)
             THEN 'assistant'
           WHEN l.role = 'prompt' OR c.platform = ${WEBCHAT_PLATFORM} THEN 'user'
           ELSE 'notification' END AS role,
      m.parts AS content, m.said_at AS created_at, m.sender_account_id AS sender_id,
      m.sender_name, COALESCE(m.sender_agent, m.sender_account_id) AS turn_sender_id,
      CASE WHEN m.sender_agent IS NOT NULL THEN m.sender_agent
           WHEN m.sender_account_id GLOB 'automated::*' THEN m.sender_account_id END AS source_id,
      m.chat_thread_id AS chat_thread_id,
      -- A turn's first prompt goes before its trace in the same second; every
      -- other line goes after it, in the order it was said, as a steered
      -- input after the card it answers.
      CASE WHEN l.role = 'prompt' AND l.turn_id IS NOT NULL AND m.id = (
          SELECT min(f.message_id) FROM agent_turn_messages f
          WHERE f.session_id = s.id AND f.turn_id = l.turn_id AND f.role = 'prompt'
        ) THEN 0 ELSE 2 END AS line_order,
      m.seq AS seq
    FROM rome_sessions s
    JOIN ${CHATS} c ON c.id = s.chat_id
    JOIN ${CHAT_MESSAGES} m ON m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
      -- A session sees the place from when it started there.
      AND m.said_at >= s.created_at
      ${
        // A line from before chat threads is in none, so the thread its own
        // key names holds it. A line that is in a thread, even one that
        // started here and moved on, is read by that thread alone.
        chatThread === undefined
          ? sql``
          : sql`AND (m.chat_thread_id = ${chatThread} OR (m.chat_thread_id IS NULL AND m.key = ${chatThread}))`
      }
    -- Only a prompt or answer link says whose turn a line is: one caught up
    -- on is read by who said it.
    LEFT JOIN agent_turn_messages l ON l.message_id = m.id AND l.session_id = s.id
      AND l.role IN ('prompt', 'answer')
    WHERE s.id IN (SELECT value FROM json_each(${ids}))
    UNION ALL
    SELECT r.id, r.session_id, r.turn_id, r.input_state, r.role,
      CASE WHEN r.role = 'trace' THEN '[]' ELSE r.content END AS content,
      r.created_at,
      CASE json_extract(r.actor, '$.kind') WHEN 'guardian' THEN 'guardian'
        WHEN 'visitor' THEN 'visitor:' || json_extract(r.actor, '$.accountId') END AS sender_id,
      json_extract(r.actor, '$.email') AS sender_name, r.sender_id AS turn_sender_id, r.sender_id AS source_id,
      NULL AS chat_thread_id,
      -- A session in no chat keeps its rows in the order they were written;
      -- beside a chat's lines, a trace goes after its turn's first prompt.
      CASE WHEN s.chat_id IS NULL THEN 0 ELSE 1 END AS line_order,
      r.rowid AS seq
    FROM rome_agent_messages r JOIN rome_sessions s ON s.id = r.session_id
    WHERE r.session_id IN (SELECT value FROM json_each(${ids}))
      AND (s.chat_id IS NULL OR r.role = 'trace')
      ${chatThread === undefined ? sql`` : sql`AND 0`}
  )`;
}

/**
 * How many lines the session in the current `rome_sessions` row draws, as
 * {@link sessionLines} does: what was said where it stands since it started
 * there, and its traces, or all its rows when it stands in no chat. For a
 * select over `rome_sessions`.
 */
const chatsSessionMessageCount = sql<number>`((
  select count(*) from ${CHAT_MESSAGES} m
  where m."chat_id" = "rome_sessions"."chat_id" and m."thread_id" is "rome_sessions"."thread_id"
    and m."said_at" >= "rome_sessions"."created_at"
) + (
  select count(*) from "rome_agent_messages" r
  where r."session_id" = "rome_sessions"."id"
    and ("rome_sessions"."chat_id" is null or r."role" = 'trace')
))`.mapWith(Number);
