// The dashboard's read model of a chat: what the guardian sees when they open
// a chat or a session, search their chats, or glance at a badge. Nothing here
// writes. Vocabulary: docs/domains/chats.md.
//
// It has two renders over one shape, a column of turns with the words around
// them. A chat transcript is Chats' one read (`MessageRepository.read`) with
// Agents' turn link attached to each message (`TurnLinks.turnsOf`). A session
// with no chat (a subagent, a fork, a handoff) keeps its turns' prompts and
// answers itself, and its transcript reads them.
// Either way each turn's trace is read apart, as a record whose blocks load
// only when the guardian opens the turn.
//
// The dashboard addresses a chat by the id of the agent's `rome_sessions` row
// it opened, as every dashboard route does today, and the session row names
// its chat. For a dashboard chat that is the chat's own id. For a chat on a
// messaging platform it is one of Rome's seats there, and the transcript shows
// the whole place: every line said in it, every turn any of Rome's agents
// took there, once.
//
// Nothing reads through it yet: the dashboard still reads its legacy tables
// until the Chats switch moves it here.

import { sql } from "drizzle-orm";
import type { AgentInputState, ChatId } from "@rome-os/app-runtime";
import { CHAT_LINES, CHATS } from "../chats/storage/lines-sql.js";
import type { SaidMessage } from "../chats/storage/message.js";
import { MessageRepository, type MessageCursor } from "../chats/storage/message-repository.js";
import { placeIn, type Place } from "../chats/storage/place.js";
import type { DrizzleDb } from "../db/index.js";
import { TurnLinks, type TurnLink } from "../sessions/turn-links.js";

/** How the dashboard draws a line. A line from Rome names the agent that said
 *  it; a line that prompted a turn is the guardian's (or a visitor's) input;
 *  anything else said in the place is a notification the agent catches up on. */
export type TranscriptRole = "user" | "assistant" | "notification";

export interface TranscriptLine {
  /** The line's id outside Rome: a chat line's adapter key, unique in its
   *  chat, or the session's own line id. */
  id: string;
  /** The agent session the line's turn ran in, or the opened session when the
   *  line belongs to no turn. */
  sessionId: string;
  turnId: string | null;
  inputState: AgentInputState | null;
  role: TranscriptRole;
  /** The line's parts as JSON. */
  content: string;
  /** Who said it, by account (`guardian`, `visitor:<id>`, a platform account),
   *  with the name the line gave. Null on a line that kept no sender. */
  senderAccountId: string | null;
  senderName: string | null;
  createdAt: Date;
}

/** One agent turn, by the agent session it ran in. */
export interface TurnRef {
  sessionId: string;
  turnId: string;
}

/** The record of what a turn did. Its blocks are read on their own, by `id`,
 *  when the dashboard summarizes or opens it. */
export interface TurnTrace extends TurnRef {
  id: string;
  createdAt: Date;
}

/** Where a page ends, handed back to read the page before it. Opaque: a
 *  message position for a chat, a turn position for a session. */
export interface TranscriptCursor {
  at: number;
  id: string;
}

export interface TranscriptPage {
  /** Messages per page of a chat, turns per page of a session. */
  limit: number;
  before?: TranscriptCursor | null;
}

/** Lines oldest first, the trace of each turn they show, and the cursor for
 *  the page before (null when none remain, and always without a page). */
export interface Transcript {
  lines: TranscriptLine[];
  traces: TurnTrace[];
  nextCursor: TranscriptCursor | null;
}

export interface ChatSearchHit {
  chatId: string;
  messageId: string;
  role: TranscriptRole;
  snippet: string;
  createdAt: Date;
}

const SEARCH_SCAN_LIMIT = 400;
const SNIPPET_CONTEXT = 40;
const SNIPPET_LENGTH = 160;
const LIKE_ESCAPE = "\\";

/** The role a chat message `m` draws as, given the turn link `l` the
 *  transcript picked for it. */
const lineRole = sql.raw(`CASE
  WHEN m.sender_agent IS NOT NULL THEN 'assistant'
  WHEN l.role = 'prompt' THEN 'user'
  ELSE 'notification' END`);

export class ChatReadModel {
  private readonly messages: Pick<MessageRepository, "read" | "idOf">;
  private readonly links: Pick<TurnLinks, "turnsOf">;

  constructor(
    private readonly db: DrizzleDb,
    deps: {
      messages?: Pick<MessageRepository, "read" | "idOf">;
      links?: Pick<TurnLinks, "turnsOf">;
    } = {},
  ) {
    this.messages = deps.messages ?? new MessageRepository(db);
    this.links = deps.links ?? new TurnLinks(db);
  }

  /**
   * The chat the session stands in, as the dashboard draws it, oldest first:
   * every message said in the place, each with the turn it prompted or
   * answered, or with a page the newest `page.limit` turns before
   * `page.before`. A message two of Rome's agents both took a turn on is
   * drawn under the first link, so it is never drawn twice. A message outside
   * any turn counts as a turn of its own. Null when the session stands in no
   * chat.
   */
  async chatTranscript(sessionId: string, page?: TranscriptPage): Promise<Transcript | null> {
    const seat = await this.seatOf(sessionId);
    if (!seat) return null;
    const { place, since } = seat;
    // A seat sees what was said where it stands from when it joined: a line
    // said in a group before Rome's account was there never reached it.
    const seen = (said: readonly SaidMessage[]) => said.filter((message) => message.at >= since);
    if (!page) {
      const read = await this.messages.read(place);
      return this.transcriptOf(sessionId, seen(read.messages), null);
    }
    // Chats reads by message, newest first. Read back in batches until the
    // page holds one turn more than asked, so the oldest turn shown is whole.
    // A cursor names its line by key, as every line goes out.
    const from = page.before ? this.messages.idOf(place.chat, page.before.id) : null;
    let before: MessageCursor | null =
      page.before && from !== null ? { at: new Date(page.before.at * 1000), id: from } : null;
    let messages: SaidMessage[] = [];
    const links = new Map<number, TurnLink>();
    let exhausted = false;
    for (;;) {
      const read = await this.messages.read(place, { before, limit: page.limit * 4 });
      const shown = seen(read.messages);
      for (const [id, link] of this.links.turnsOf(shown.map((m) => m.id))) {
        links.set(id, link);
      }
      messages = [...shown, ...messages];
      if (!read.older || shown.length < read.messages.length) exhausted = true;
      before = read.older;
      if (exhausted || turnKeys(messages, links).size > page.limit) break;
    }
    // Keep the newest `limit` turns: walking back from the newest message,
    // stop at the first message of a turn past the limit.
    const kept = new Set<string>();
    let cut = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const key = turnKey(messages[index] as SaidMessage, links);
      if (!kept.has(key)) {
        if (kept.size === page.limit) {
          cut = index + 1;
          break;
        }
        kept.add(key);
      }
    }
    const shown = messages.slice(cut).filter((message) => kept.has(turnKey(message, links)));
    const oldest = shown[0];
    const more = cut > 0 || !exhausted;
    return this.transcriptOf(
      sessionId,
      shown,
      more && oldest ? { at: oldest.at.getTime() / 1000, id: oldest.key } : null,
      links,
    );
  }

  private async transcriptOf(
    sessionId: string,
    messages: readonly SaidMessage[],
    nextCursor: TranscriptCursor | null,
    known?: Map<number, TurnLink>,
  ): Promise<Transcript> {
    const links = known ?? this.links.turnsOf(messages.map((message) => message.id));
    const lines = messages.map((message) => chatLine(message, links.get(message.id), sessionId));
    return { lines, traces: await this.tracesOf(lines), nextCursor };
  }

  /**
   * The turns of a session that stands in no chat (a subagent, a fork, a
   * handoff), from the prompts, answers and traces it keeps itself: the
   * newest `page.limit` before `page.before` (every turn without a page),
   * whole, oldest first. A turn stands where its first line was said, and a
   * line outside any turn is a turn of its own.
   */
  async sessionTranscript(sessionId: string, page?: TranscriptPage): Promise<Transcript> {
    const before = page?.before ?? null;
    const rows = await this.db.all<{
      id: string;
      turn_id: string | null;
      role: TranscriptRole | "trace";
      content: string;
      sender_name: string | null;
      at: number;
      turn: string;
      turn_at: number;
    }>(sql`
      WITH line AS (
        SELECT id, turn_id, role, content, json_extract(actor, '$.email') AS sender_name,
          created_at AS at, rowid AS seq, coalesce(turn_id, id) AS turn
        FROM rome_agent_messages WHERE session_id = ${sessionId}
      ),
      turn AS (
        SELECT turn, min(at) AS turn_at, min(seq) AS turn_seq FROM line GROUP BY turn
      ),
      shown AS (
        SELECT * FROM turn
        WHERE ${before === null ? 1 : 0} OR turn_at < ${before?.at ?? 0} OR (turn_at = ${before?.at ?? 0}
          AND turn_seq < (SELECT turn_seq FROM turn WHERE turn = ${before?.id ?? ""}))
        ORDER BY turn_at DESC, turn_seq DESC
        -- One turn past the page tells whether more remain.
        LIMIT ${page ? page.limit + 1 : -1}
      )
      SELECT line.*, shown.turn_at FROM line JOIN shown USING (turn)
      ORDER BY shown.turn_at, shown.turn_seq, line.at, line.seq`);
    const more = page !== undefined && new Set(rows.map((row) => row.turn)).size > page.limit;
    const shown = more ? rows.filter((row) => row.turn !== rows[0]?.turn) : rows;
    const lines: TranscriptLine[] = [];
    const traces: TurnTrace[] = [];
    for (const row of shown) {
      const createdAt = new Date(row.at * 1000);
      if (row.role !== "trace") {
        lines.push({
          id: row.id,
          sessionId,
          turnId: row.turn_id,
          inputState: null,
          role: row.role,
          content: row.content,
          senderAccountId: null,
          senderName: row.sender_name,
          createdAt,
        });
      } else if (row.turn_id !== null) {
        traces.push({ id: row.id, sessionId, turnId: row.turn_id, createdAt });
      }
    }
    const oldest = shown[0];
    return {
      lines,
      traces,
      nextCursor: more && oldest ? { at: oldest.turn_at, id: oldest.turn } : null,
    };
  }

  /** The place the session stands in, its chat's key and its thread, and
   *  when the seat joined it. */
  private async seatOf(sessionId: string): Promise<{ place: Place; since: Date } | null> {
    const [row] = await this.db.all<{
      platform: string;
      chat_id: number;
      thread_id: string | null;
      created_at: number;
    }>(sql`
      SELECT c.platform, c.id AS chat_id, r.thread_id, r.created_at
      FROM rome_sessions r JOIN ${CHATS} c ON c.id = r.chat_id
      WHERE r.id = ${sessionId}
    `);
    if (!row) return null;
    return {
      place: placeIn(
        { platform: row.platform, id: row.chat_id },
        (row.thread_id ?? undefined) as ChatId | undefined,
      ),
      since: new Date(row.created_at * 1000),
    };
  }

  /** The trace of each turn `lines` belong to that has one. */
  private async tracesOf(lines: readonly TranscriptLine[]): Promise<TurnTrace[]> {
    const turns = new Map<string, TurnRef>();
    for (const line of lines) {
      if (line.turnId) {
        turns.set(JSON.stringify([line.sessionId, line.turnId]), {
          sessionId: line.sessionId,
          turnId: line.turnId,
        });
      }
    }
    if (turns.size === 0) return [];
    const wanted = sql.join(
      [...turns.values()].map((turn) => sql`(${turn.sessionId}, ${turn.turnId})`),
      sql`, `,
    );
    const rows = await this.db.all<{
      id: string;
      session_id: string;
      turn_id: string;
      created_at: number;
    }>(sql`
      WITH wanted(session_id, turn_id) AS (VALUES ${wanted})
      SELECT t.id, t.session_id, t.turn_id, t.created_at
      FROM wanted w
      JOIN rome_agent_messages t
        ON t.session_id = w.session_id AND t.turn_id = w.turn_id AND t.role = 'trace'
      ORDER BY t.created_at, t.rowid
    `);
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      createdAt: new Date(row.created_at * 1000),
    }));
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
      SELECT m.key AS id, s.id AS chat_id, ${lineRole} AS role, m.text, m.said_at
      FROM ${CHAT_LINES} m
      JOIN ${CHATS} c ON c.id = m.chat_id AND c.platform = 'webchat'
      JOIN rome_sessions s ON s.chat_id = c.id
      LEFT JOIN agent_turn_messages l ON l.message_id = m.id AND l.session_id = s.id
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
        JOIN ${CHAT_LINES} m ON m.chat_id = r.chat_id AND m.thread_id IS r.thread_id
        WHERE r.id = ${sessionId} AND r.last_seen_activity_at IS NOT NULL
          AND m.sender_agent IS NOT NULL
          AND m.said_at > r.last_seen_activity_at
        LIMIT ${cap}
      )`);
    return Number(row?.count ?? 0);
  }
}

/** The turn a message is drawn under: its link's turn, or itself. */
function turnKey(message: SaidMessage, links: ReadonlyMap<number, TurnLink>): string {
  return links.get(message.id)?.turnId ?? `line:${message.id}`;
}

function turnKeys(
  messages: readonly SaidMessage[],
  links: ReadonlyMap<number, TurnLink>,
): Set<string> {
  return new Set(messages.map((message) => turnKey(message, links)));
}

function chatLine(
  message: SaidMessage,
  link: TurnLink | undefined,
  openedSessionId: string,
): TranscriptLine {
  return {
    id: message.key,
    sessionId: link?.sessionId ?? openedSessionId,
    turnId: link?.turnId ?? null,
    inputState: link?.inputState ?? null,
    role:
      message.direction === "fromRome"
        ? "assistant"
        : link?.role === "prompt"
          ? "user"
          : "notification",
    content: message.parts,
    senderAccountId: message.saidBy?.account.id ?? null,
    senderName: message.senderName ?? null,
    createdAt: message.at,
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
