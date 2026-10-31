// The dashboard's read model of a chat: what the guardian sees when they open
// a chat or a session, search their chats, or glance at a badge. Nothing here
// writes. Vocabulary: docs/domains/chats.md.
//
// It has two renders over one shape, a column of turns with the words around
// them. A chat transcript is Chats' one read (`MessageRepository.read`) with
// Agents' turn link attached to each message (`TurnLinks.turnsOf`). A session
// transcript is Agents' turns of one session (`TurnLinks.turns`): the messages
// its turns took and gave, or for a session with no chat (a subagent, a fork,
// a handoff) the turn's own prompt and answer.
// Either way each turn's trace is read apart, as a record whose blocks load
// only when the guardian opens the turn.
//
// The dashboard addresses a chat by the id of the agent's `rome_sessions` row
// it opened, as every dashboard route does today, and the session row names
// its chat. For a dashboard chat that is the chat's own id. For a chat on a
// messaging platform it is one of Rome's seats there, and the transcript shows
// the whole place: every line said in it, every turn any of Rome's agents
// took there, once.

import { sql } from "drizzle-orm";
import type { AgentInputState, ChatId } from "@rome-os/app-runtime";
import type { SaidMessage } from "../chats/message.js";
import { MessageRepository, type MessageCursor } from "../chats/message-repository.js";
import { chatKey, placeIn, type Place } from "../chats/place.js";
import type { DrizzleDb } from "../db/index.js";
import { TurnLinks, type TurnLink, type TurnLine } from "../sessions/turn-links.js";

/** How the dashboard draws a line. A line from Rome names the agent that said
 *  it; a line that prompted a turn is the guardian's (or a visitor's) input;
 *  anything else said in the place is a notification the agent catches up on. */
export type TranscriptRole = "user" | "assistant" | "notification";

export interface TranscriptLine {
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
  private readonly messages: Pick<MessageRepository, "read">;
  private readonly links: Pick<TurnLinks, "turnsOf" | "turns">;

  constructor(
    private readonly db: DrizzleDb,
    deps: {
      messages?: Pick<MessageRepository, "read">;
      links?: Pick<TurnLinks, "turnsOf" | "turns">;
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
    const place = await this.placeOf(sessionId);
    if (!place) return null;
    if (!page) {
      const read = await this.messages.read(place);
      return this.transcriptOf(sessionId, read.messages, null);
    }
    // Chats reads by message, newest first. Read back in batches until the
    // page holds one turn more than asked, so the oldest turn shown is whole.
    let before: MessageCursor | null = page.before
      ? { at: new Date(page.before.at * 1000), id: page.before.id }
      : null;
    let messages: SaidMessage[] = [];
    const links = new Map<string, TurnLink>();
    let exhausted = false;
    for (;;) {
      const read = await this.messages.read(place, { before, limit: page.limit * 4 });
      for (const [id, link] of this.links.turnsOf(read.messages.map((m) => m.id))) {
        links.set(id, link);
      }
      messages = [...read.messages, ...messages];
      if (!read.older) exhausted = true;
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
      more && oldest ? { at: oldest.at.getTime() / 1000, id: oldest.id } : null,
      links,
    );
  }

  private async transcriptOf(
    sessionId: string,
    messages: readonly SaidMessage[],
    nextCursor: TranscriptCursor | null,
    known?: Map<string, TurnLink>,
  ): Promise<Transcript> {
    const links = known ?? this.links.turnsOf(messages.map((message) => message.id));
    const lines = messages.map((message) => chatLine(message, links.get(message.id), sessionId));
    return { lines, traces: await this.tracesOf(lines), nextCursor };
  }

  /**
   * One session's turns, the newest `page.limit` before `page.before` (every
   * turn without a page), whole, oldest first: for a session in a chat the
   * messages its turns took and gave, and for one with no chat (a subagent,
   * a fork, a handoff) each turn's own prompt and answer. Turns order by
   * their first line.
   */
  async sessionTranscript(sessionId: string, page?: TranscriptPage): Promise<Transcript> {
    const { lines: turnLines, older } = this.links.turns(sessionId, {
      before: page?.before ?? null,
      ...(page ? { limit: page.limit } : {}),
    });
    const traces: TurnTrace[] = [];
    const lines: TranscriptLine[] = [];
    for (const line of turnLines) {
      if (line.role !== "trace") lines.push(sessionLine(line, sessionId));
      else if (line.turnId !== null) {
        traces.push({ id: line.id, sessionId, turnId: line.turnId, createdAt: line.at });
      }
    }
    return { lines, traces, nextCursor: older };
  }

  /** The place the session stands in: its chat's key and its thread. */
  private async placeOf(sessionId: string): Promise<Place | null> {
    const [row] = await this.db.all<{
      platform: string;
      platform_chat_id: string;
      thread_id: string | null;
    }>(sql`
      SELECT c.platform, c.platform_chat_id, r.thread_id
      FROM rome_sessions r JOIN chats c ON c.id = r.chat_id
      WHERE r.id = ${sessionId}
    `);
    if (!row) return null;
    return placeIn(
      chatKey(row.platform, row.platform_chat_id as ChatId),
      (row.thread_id ?? undefined) as ChatId | undefined,
    );
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
      SELECT m.id, s.id AS chat_id, ${lineRole} AS role, m.text, m.said_at
      FROM chat_messages m
      JOIN chats c ON c.id = m.chat_id AND c.platform = 'webchat'
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
        JOIN chat_messages m ON m.chat_id = r.chat_id AND m.thread_id IS r.thread_id
        WHERE r.id = ${sessionId} AND r.last_seen_activity_at IS NOT NULL
          AND m.sender_agent IS NOT NULL
          AND m.said_at > r.last_seen_activity_at
        LIMIT ${cap}
      )`);
    return Number(row?.count ?? 0);
  }
}

/** The turn a message is drawn under: its link's turn, or itself. */
function turnKey(message: SaidMessage, links: ReadonlyMap<string, TurnLink>): string {
  return links.get(message.id)?.turnId ?? message.id;
}

function turnKeys(
  messages: readonly SaidMessage[],
  links: ReadonlyMap<string, TurnLink>,
): Set<string> {
  return new Set(messages.map((message) => turnKey(message, links)));
}

function chatLine(
  message: SaidMessage,
  link: TurnLink | undefined,
  openedSessionId: string,
): TranscriptLine {
  return {
    id: message.id,
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

function sessionLine(line: TurnLine, sessionId: string): TranscriptLine {
  return {
    id: line.id,
    sessionId,
    turnId: line.turnId,
    inputState: line.inputState,
    role: line.role as TranscriptRole,
    content: line.content,
    senderAccountId: line.senderAccountId,
    senderName: line.senderName,
    createdAt: line.at,
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
