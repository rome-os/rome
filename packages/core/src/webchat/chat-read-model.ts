// The dashboard's read model of a chat: what the guardian sees when they open
// a chat, search their chats, or glance at a badge. It reads Chats' tables
// (`chat_messages` and the delivery beside each line) and joins Agents' facts
// onto them (`agent_turn_messages` for which turn a line belongs to, and the
// `role = 'trace'` rows of `rome_agent_messages` for what the turn did).
// Nothing here writes. Vocabulary: docs/domains/chats.md.
//
// The dashboard addresses a chat by the id of the agent's `rome_sessions` row
// it opened, as every dashboard route does today. For a dashboard chat that is
// the chat's own id. For a chat on a messaging platform it is one of Rome's
// seats there, and the transcript shows the whole place: every line said in
// it, every turn any of Rome's agents took there, once.

import { sql, type SQL } from "drizzle-orm";
import type { AgentInputState } from "@rome-os/app-runtime";
import type { DrizzleDb } from "../db/index.js";

/** How the dashboard draws a line. A line from Rome has a delivery; a line
 *  that prompted a turn is the guardian's (or a visitor's) input; anything
 *  else said in the place is a notification the agent catches up on. */
export type TranscriptRole = "user" | "assistant" | "notification" | "trace";

export interface TranscriptLine {
  id: string;
  /** The agent session the line's turn ran in, or the opened session when the
   *  line belongs to no turn. */
  sessionId: string;
  turnId: string | null;
  inputState: AgentInputState | null;
  role: TranscriptRole;
  /** The line's parts as JSON. A trace line's is `[]`: its blocks are read on
   *  their own, per trace id. */
  content: string;
  /** Who said it, by account (`guardian`, `visitor:<id>`, a platform account),
   *  with the name the line gave. Null on a trace and on a legacy line that
   *  kept no sender. */
  senderAccountId: string | null;
  senderName: string | null;
  createdAt: Date;
}

/** A position between turns, newest first: the turn's first line's time and
 *  its key (the turn id, or the line id for a line outside any turn). */
export interface TurnCursor {
  startedAt: number;
  key: string;
}

export interface TranscriptPage {
  /** Turns per page. A line outside any turn counts as one. */
  limit: number;
  /** Only turns strictly older than this position. */
  before?: TurnCursor | null;
}

export interface ChatSearchHit {
  chatId: string;
  messageId: string;
  role: Exclude<TranscriptRole, "trace">;
  snippet: string;
  createdAt: Date;
}

const SEARCH_SCAN_LIMIT = 400;
const SNIPPET_CONTEXT = 40;
const SNIPPET_LENGTH = 160;
const LIKE_ESCAPE = "\\";

/** The role a chat message `m` draws as, given its delivery `d` and the turn
 *  link `l` the transcript picked for it. */
const lineRole = sql.raw(`CASE
  WHEN d.message_id IS NOT NULL THEN 'assistant'
  WHEN l.role = 'prompt' THEN 'user'
  ELSE 'notification' END`);

export class ChatReadModel {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * The chat as the dashboard draws it, newest turns first when paged: every
   * line said in the place the session sits in, and the trace of every turn
   * any of Rome's agents took there, grouped so a turn's prompt, trace and
   * answer stay together and never split across pages. Without `page`, the
   * whole chat. Null when the session is not a seat in a chat (a handoff, a
   * subagent or an unpromoted fork), which has no chat to read.
   */
  async transcript(
    sessionId: string,
    page?: TranscriptPage,
  ): Promise<{ lines: TranscriptLine[]; nextCursor: TurnCursor | null } | null> {
    const [seat] = await this.db.all<{ chat_id: string | null; thread_id: string | null }>(
      sql`SELECT chat_id, thread_id FROM rome_sessions WHERE id = ${sessionId}`,
    );
    if (!seat?.chat_id) return null;
    const before = page?.before;
    const rows = await this.db.all<TranscriptRow>(sql`
      WITH seats AS (
        SELECT id FROM rome_sessions WHERE chat_id = ${seat.chat_id} AND thread_id IS ${seat.thread_id}
      ),
      lines AS (
        -- What was said: one row per message, with the turn it prompted or
        -- answered. A line two of Rome's agents both took a turn on is drawn
        -- under the first link, so it is never drawn twice.
        SELECT m.id, coalesce(l.session_id, ${sessionId}) AS session_id, l.turn_id, l.input_state,
               ${lineRole} AS role, m.parts AS content,
               m.sender_account_id, m.sender_name, m.said_at AS at,
               CASE WHEN l.role = 'prompt' THEN 0 ELSE 2 END AS rank, m.rowid AS seq
        FROM chat_messages m
        LEFT JOIN chat_message_deliveries d ON d.message_id = m.id
        LEFT JOIN agent_turn_messages l ON l.rowid = (
          SELECT x.rowid FROM agent_turn_messages x
          WHERE x.message_id = m.id AND x.role IN ('prompt', 'answer')
            AND x.session_id IN (SELECT id FROM seats)
          ORDER BY x.rowid LIMIT 1)
        WHERE m.chat_id = ${seat.chat_id} AND m.thread_id IS ${seat.thread_id}
        UNION ALL
        -- What each turn did: its trace, read from Agents. The unary plus
        -- keeps SQLite on the session index rather than walking every trace.
        SELECT t.id, t.session_id, t.turn_id, NULL, 'trace', '[]',
               NULL, NULL, t.created_at, 1, t.rowid
        FROM seats s
        JOIN rome_agent_messages t ON t.session_id = s.id AND +t.role = 'trace'
      ),
      keyed AS (
        SELECT *, coalesce(turn_id, id) AS key,
               MIN(at) OVER (PARTITION BY coalesce(turn_id, id)) AS started_at
        FROM lines
      ),
      turns AS (
        SELECT DISTINCT key, started_at FROM keyed
        ${before ? sql`WHERE (started_at, key) < (${before.startedAt}, ${before.key})` : sql``}
        ORDER BY started_at DESC, key DESC
        ${page ? sql`LIMIT ${page.limit + 1}` : sql``}
      )
      SELECT keyed.* FROM keyed JOIN turns USING (key)
      ORDER BY keyed.started_at, keyed.key, keyed.at, keyed.rank, keyed.seq
    `);
    const turnStarts = new Map<string, number>();
    for (const row of rows) turnStarts.set(row.key, row.started_at);
    const newestFirst = [...turnStarts].sort(([ak, as], [bk, bs]) =>
      bs !== as ? bs - as : bk < ak ? -1 : bk > ak ? 1 : 0,
    );
    const shown = page ? newestFirst.slice(0, page.limit) : newestFirst;
    const shownKeys = new Set(shown.map(([key]) => key));
    const oldest = shown[shown.length - 1];
    return {
      lines: rows.filter((row) => shownKeys.has(row.key)).map(toLine),
      nextCursor:
        page && newestFirst.length > page.limit && oldest
          ? { startedAt: oldest[1], key: oldest[0] }
          : null,
    };
  }

  /**
   * The dashboard chats whose lines hold every whitespace-separated term of
   * `query`, case-insensitive, each with its most recent matching line and a
   * snippet around the first hit, most recent first, at most `limit` chats.
   */
  async search(query: string, limit: number): Promise<ChatSearchHit[]> {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const matchesEveryTerm = sql.join(
      terms.map((term) => sql`lower(m.text) LIKE ${`%${escapeLike(term)}%`} ESCAPE ${LIKE_ESCAPE}`),
      sql` AND `,
    );
    const rows = await this.db.all<{
      id: string;
      chat_id: string;
      role: ChatSearchHit["role"];
      text: string;
      said_at: number;
    }>(sql`
      SELECT m.id, m.chat_id, ${lineRole} AS role, m.text, m.said_at
      FROM chat_messages m
      JOIN chats c ON c.id = m.chat_id AND c.platform = 'webchat'
      LEFT JOIN chat_message_deliveries d ON d.message_id = m.id
      LEFT JOIN agent_turn_messages l ON l.message_id = m.id AND l.session_id = m.chat_id
      WHERE ${matchesEveryTerm}
      ORDER BY m.said_at DESC, m.id DESC
      LIMIT ${SEARCH_SCAN_LIMIT}
    `);
    const hits: ChatSearchHit[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.chat_id)) continue;
      const snippet = snippetAround(row.text.replace(/\s+/g, " ").trim(), terms);
      if (!snippet) continue;
      seen.add(row.chat_id);
      hits.push({
        chatId: row.chat_id,
        messageId: row.id,
        role: row.role,
        snippet,
        createdAt: new Date(row.said_at * 1000),
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /**
   * How many lines from Rome the chat got since the guardian last read it,
   * counting at most `cap`. A chat never marked read has none. Times have
   * one-second precision, so a line in the same second as the mark is read.
   */
  async unreadCount(sessionId: string, cap: number): Promise<number> {
    const [row] = await this.db.all<{ count: number }>(sql`
      SELECT count(*) AS count FROM (
        SELECT 1 FROM rome_sessions r
        JOIN chat_messages m ON m.chat_id = r.chat_id AND m.thread_id IS r.thread_id
        JOIN chat_message_deliveries d ON d.message_id = m.id
        WHERE r.id = ${sessionId} AND r.last_seen_activity_at IS NOT NULL
          AND m.said_at > r.last_seen_activity_at
        LIMIT ${cap}
      )`);
    return Number(row?.count ?? 0);
  }
}

/** For the sidebar's list of chats, per `rome_sessions` row in the outer
 *  query: how many lines the transcript holds (messages and traces). */
export const chatLineCount: SQL<number> = sql<number>`(
  (SELECT count(*) FROM chat_messages m
   WHERE m.chat_id = "rome_sessions"."chat_id" AND m.thread_id IS "rome_sessions"."thread_id")
  + (SELECT count(*) FROM rome_agent_messages t
     WHERE t.session_id = "rome_sessions"."id" AND t.role = 'trace')
)`.mapWith(Number);

/** For the sidebar, per `rome_sessions` row in the outer query: whether the
 *  chat waits on the guardian, because a line from Rome after the guardian's
 *  last line holds a card (question, connect-AI, app component), or an
 *  approval in the chat is pending. Any answer to a card is saved as the
 *  guardian's line, so a card after the last one is still open. */
export const chatAwaitingGuardian: SQL<boolean> = sql<boolean>`(exists (
  SELECT 1 FROM chat_messages m
  JOIN chat_message_deliveries d ON d.message_id = m.id, json_each(m.parts) part
  WHERE m.chat_id = "rome_sessions"."chat_id" AND m.thread_id IS "rome_sessions"."thread_id"
    AND json_valid(m.parts)
    AND m.rowid > coalesce((
      SELECT max(u.rowid) FROM chat_messages u
      WHERE u.chat_id = "rome_sessions"."chat_id" AND u.thread_id IS "rome_sessions"."thread_id"
        AND NOT EXISTS (SELECT 1 FROM chat_message_deliveries ud WHERE ud.message_id = u.id)
        AND EXISTS (SELECT 1 FROM agent_turn_messages ul
                    WHERE ul.message_id = u.id AND ul.role = 'prompt')
    ), 0)
    AND CASE WHEN part.type = 'object' THEN json_extract(part.value, '$.type') END = 'pending_interaction'
) OR "rome_sessions"."id" IN (
  SELECT json_extract(a.payload, '$.channelContext.threadId') FROM approvals a
  WHERE a.status = 'pending' AND json_extract(a.payload, '$.channelContext.threadId') IS NOT NULL
))`.mapWith(Boolean);

interface TranscriptRow {
  id: string;
  session_id: string;
  turn_id: string | null;
  input_state: AgentInputState | null;
  role: TranscriptRole;
  content: string;
  sender_account_id: string | null;
  sender_name: string | null;
  at: number;
  key: string;
  started_at: number;
}

function toLine(row: TranscriptRow): TranscriptLine {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    inputState: row.input_state,
    role: row.role,
    content: row.content,
    senderAccountId: row.sender_account_id,
    senderName: row.sender_name,
    createdAt: new Date(row.at * 1000),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `${LIKE_ESCAPE}${character}`);
}

function snippetAround(text: string, terms: string[]): string | null {
  const lowered = text.toLocaleLowerCase();
  let firstHit = Number.POSITIVE_INFINITY;
  for (const term of terms) {
    const at = lowered.indexOf(term);
    if (at === -1) return null;
    if (at < firstHit) firstHit = at;
  }
  let start = Math.max(0, firstHit - SNIPPET_CONTEXT);
  if (start > 0) {
    const boundary = text.indexOf(" ", start);
    if (boundary !== -1 && boundary < firstHit) start = boundary + 1;
  }
  const end = Math.min(text.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
