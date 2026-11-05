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
// messaging platform it is one of Rome's speakers there, and the transcript shows
// the whole place: every line said in it, every turn any of Rome's agents
// took there, once.
//
// Nothing reads through it yet: the dashboard still reads its legacy tables
// until the Chats switch moves it here.

import { sql } from "drizzle-orm";
import { automatedSource } from "./automated-source.js";
import type { AgentInputState, ChatId } from "@rome-os/app-runtime";
import { CHAT_MESSAGES, CHATS } from "../chats/storage/messages-sql.js";
import type { SaidMessage } from "../chats/storage/message.js";
import { MessageRepository, type MessageCursor } from "../chats/storage/message-repository.js";
import { placeIn, type Place } from "../chats/storage/place.js";
import type { DrizzleDb } from "../db/index.js";
import { TurnLinks, type TurnLink } from "../sessions/turn-links.js";
import { createTurnReads, type TurnReads } from "../agent-sessions/index.js";

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

/**
 * Whether the session in the current `rome_sessions` row waits on the
 * guardian, read from Chats: a card (question, connect-AI, app component) in
 * a line from Rome after the last prompt where the session's speaker stands,
 * or an approval still pending in this chat. Any answer to a card is a line
 * prompting a turn, the guardian's own or one Concierge relays for them, so a
 * card after the last one is still open. `seq` is the order Chats recorded
 * lines in. The last prompt is found once per session (`last`) rather than
 * once per line from Rome, which walked the place again for each line. The
 * pending approvals' chats are collected once per list rather than scanned
 * per chat.
 * json_valid and the object check skip lines whose parts are not a block
 * array, which would otherwise fail the whole list. The Chats version of the
 * legacy `sessionAwaitingGuardian` (db/repositories/webchat.ts), for a
 * select over `rome_sessions`.
 */
export const chatsSessionAwaitingGuardian = sql<boolean>`(exists (
  select 1 from (
    select coalesce(max(u."seq"), 0) as "cut" from ${CHAT_MESSAGES} u
    where u."chat_id" = "rome_sessions"."chat_id" and u."thread_id" is "rome_sessions"."thread_id"
    and exists (select 1 from "agent_turn_messages" ul where ul."message_id" = u."id" and ul."role" = 'prompt')
  ) last
  cross join ${CHAT_MESSAGES} m
  cross join json_each(m."parts") part
  where m."chat_id" = "rome_sessions"."chat_id" and m."thread_id" is "rome_sessions"."thread_id"
  and m."seq" > last."cut"
  and m."sender_agent" is not null and json_valid(m."parts")
  and case when part."type" = 'object' then json_extract(part."value", '$.type') end = 'pending_interaction'
) or "rome_sessions"."id" in (
  select json_extract(a."payload", '$.channelContext.threadId') from "approvals" a
  where a."status" = 'pending'
  and json_extract(a."payload", '$.channelContext.threadId') is not null
))`.mapWith(Boolean);

const SEARCH_SCAN_LIMIT = 400;
const SNIPPET_CONTEXT = 40;
const SNIPPET_LENGTH = 160;
const LIKE_ESCAPE = "\\";

export class ChatReadModel {
  private readonly messages: Pick<MessageRepository, "read" | "idOf" | "byIds">;
  private readonly links: Pick<TurnLinks, "turnsOf">;
  private readonly turns: Pick<TurnReads, "keptTurns" | "traceHeadsOf">;

  constructor(
    private readonly db: DrizzleDb,
    deps: {
      messages?: Pick<MessageRepository, "read" | "idOf" | "byIds">;
      links?: Pick<TurnLinks, "turnsOf">;
      /** Sessions' turns, whose traces and kept messages it shows. */
      turns?: Pick<TurnReads, "keptTurns" | "traceHeadsOf">;
    } = {},
  ) {
    this.messages = deps.messages ?? new MessageRepository(db);
    this.links = deps.links ?? new TurnLinks(db);
    this.turns = deps.turns ?? createTurnReads(db);
  }

  /**
   * The chat the session stands in, as the dashboard draws it, oldest first:
   * every message said in the place, each with the turn it prompted or
   * answered, or with a page the newest `page.limit` turns before
   * `page.before`. A message two of Rome's agents both took a turn on is
   * drawn under the first link, so it is never drawn twice. A message outside
   * any turn counts as a turn of its own. A turn is placed by its newest
   * line and shown whole, with all its lines, even where other turns' lines
   * fall between them, so pages never split or repeat a turn. Every message
   * recorded in the place is drawn, so where each of Rome's accounts holds
   * its own copy of one (#1670), each copy is. Null when the session stands
   * in no chat.
   */
  async chatTranscript(sessionId: string, page?: TranscriptPage): Promise<Transcript | null> {
    const speaker = await this.speakerOf(sessionId);
    if (!speaker) return null;
    const { place, since } = speaker;
    // A speaker sees what was said where it stands from when it joined: a line
    // said in a group before Rome's account was there never reached it.
    const seen = (said: readonly SaidMessage[]) => said.filter((message) => message.at >= since);
    if (!page) {
      const read = await this.messages.read(place);
      return this.transcriptOf(sessionId, seen(read.messages), null);
    }
    // A cursor names the newest line of the oldest turn already shown, by
    // its key, as every line goes out. This page holds turns whose newest
    // line is older.
    const from = page.before ? this.messages.idOf(place.chat, page.before.id) : null;
    const cursor: MessageCursor | null =
      page.before && from !== null ? { at: new Date(page.before.at * 1000), id: from } : null;
    const older = (message: SaidMessage) => cursor === null || before(message, cursor);
    const kept = new Map<string, readonly SaidMessage[]>();
    const passed = new Set<string>();
    let more = false;
    let next: SaidMessage | null = null;
    // Chats reads by message, newest first: walk back in batches, meeting
    // each turn first at its newest line.
    let batch: MessageCursor | null = cursor;
    scan: for (;;) {
      const read = await this.messages.read(place, { before: batch, limit: page.limit * 4 });
      const shown = seen(read.messages);
      const links = this.links.turnsOf(shown.map((message) => message.id));
      for (const message of [...shown].reverse()) {
        const key = turnKey(message, links);
        if (kept.has(key) || passed.has(key)) continue;
        // The turn is placed by the newest line it draws.
        const lines = seen(await this.linesOfTurn(place, message, links.get(message.id)));
        const newest = lines.at(-1) ?? message;
        // A turn whose newest line is newer than the cursor was shown before.
        if (!older(newest)) {
          passed.add(key);
          continue;
        }
        if (kept.size === page.limit) {
          more = true;
          break scan;
        }
        kept.set(key, lines);
        next = newest;
      }
      if (!read.older || shown.length < read.messages.length) break;
      batch = read.older;
    }
    const lines = [...new Map([...kept.values()].flat().map((m) => [m.id, m])).values()].sort(
      (a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0),
    );
    return this.transcriptOf(
      sessionId,
      lines,
      more && next ? { at: next.at.getTime() / 1000, id: next.key } : null,
    );
  }

  /** Every line drawn under the turn `link` names, `message` among them,
   *  oldest first: the turn's prompts and answers in `place` whose first link
   *  is this turn's. A message no turn took is a turn of its own. */
  private async linesOfTurn(
    place: Place,
    message: SaidMessage,
    link: TurnLink | undefined,
  ): Promise<SaidMessage[]> {
    if (!link?.turnId) return [message];
    const ids = (
      await this.db.all<{ message_id: number }>(sql`
        SELECT message_id FROM agent_turn_messages
        WHERE session_id = ${link.sessionId} AND turn_id = ${link.turnId}
          AND role IN ('prompt', 'answer')
      `)
    ).map((row) => row.message_id);
    const drawn = this.links.turnsOf(ids);
    return this.messages
      .byIds(
        ids.filter((id) => {
          const first = drawn.get(id);
          return first?.sessionId === link.sessionId && first.turnId === link.turnId;
        }),
      )
      .filter(
        (line) => line.place.chat.id === place.chat.id && line.place.threadId === place.threadId,
      );
  }

  private async transcriptOf(
    sessionId: string,
    messages: readonly SaidMessage[],
    nextCursor: TranscriptCursor | null,
  ): Promise<Transcript> {
    const ids = messages.map((message) => message.id);
    const links = this.links.turnsOf(ids);
    const lines = messages.map((message) => chatLine(message, links.get(message.id), sessionId));
    // Every turn a shown line prompted or answered has its trace shown, also
    // one whose lines are drawn under another agent's turn.
    const turns = await this.turnsAt(ids);
    return { lines, traces: await this.tracesOf(turns), nextCursor };
  }

  /** Every turn that prompted on or answered with one of `messageIds`. */
  private async turnsAt(messageIds: readonly number[]): Promise<TurnRef[]> {
    if (messageIds.length === 0) return [];
    return (
      await this.db.all<{ session_id: string; turn_id: string }>(sql`
        SELECT DISTINCT session_id, turn_id FROM agent_turn_messages
        WHERE message_id IN (SELECT value FROM json_each(${JSON.stringify(messageIds)}))
          AND role IN ('prompt', 'answer') AND turn_id IS NOT NULL
      `)
    ).map((row) => ({ sessionId: row.session_id, turnId: row.turn_id }));
  }

  /**
   * The turns of a session that stands in no chat (a subagent, a fork, a
   * handoff), from the prompts, answers and traces it keeps itself: the
   * newest `page.limit` before `page.before` (every turn without a page),
   * whole, oldest first. A turn stands where its first line was said, and a
   * line outside any turn is a turn of its own.
   */
  async sessionTranscript(sessionId: string, page?: TranscriptPage): Promise<Transcript> {
    const kept = await this.turns.keptTurns(sessionId, page);
    return {
      lines: kept.messages.map((message) => ({
        ...message,
        sessionId,
        senderAccountId: null,
      })),
      traces: kept.traces,
      nextCursor: kept.nextCursor,
    };
  }

  /** The place the session stands in, its chat and its thread, and when the
   *  speaker joined it. */
  private async speakerOf(sessionId: string): Promise<{ place: Place; since: Date } | null> {
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

  /** The trace of each of `refs` that has one. */
  private tracesOf(refs: readonly TurnRef[]): Promise<TurnTrace[]> {
    return this.turns.traceHeadsOf(refs);
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
      line: number;
      id: string;
      chat_id: string;
      from_rome: number;
      text: string;
      said_at: number;
    }>(sql`
      SELECT m.id AS line, m.key AS id, s.id AS chat_id,
        m.sender_agent IS NOT NULL AS from_rome, m.text, m.said_at
      -- CROSS JOIN keeps the lines outside: one pass over them, which the
      -- match needs anyway, and the joins only for the lines that match.
      -- Left to choose, SQLite reaches every line through each chat's index.
      FROM ${CHAT_MESSAGES} m
      CROSS JOIN ${CHATS} c ON c.id = m.chat_id AND c.platform = 'webchat'
      -- A speaker finds what its transcript draws: its own thread, from when it
      -- joined.
      CROSS JOIN rome_sessions s ON s.chat_id = c.id AND m.thread_id IS s.thread_id
        AND m.said_at >= s.created_at
      WHERE ${matchesEveryTerm}
      ORDER BY m.said_at DESC, m.id DESC
      LIMIT ${SEARCH_SCAN_LIMIT}
    `);
    // A hit draws as its line does in the transcript, under the line's
    // first turn link whichever speaker holds it.
    const links = this.links.turnsOf(rows.map((row) => row.line));
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
        role: row.from_rome
          ? "assistant"
          : links.get(row.line)?.role === "prompt"
            ? "user"
            : "notification",
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
    const speaker = await this.speakerOf(sessionId);
    const [mark] = await this.db.all<{ at: number | null }>(sql`
      SELECT last_seen_activity_at AS at FROM rome_sessions WHERE id = ${sessionId}
    `);
    if (!speaker || mark?.at == null) return 0;
    const { place } = speaker;
    const fromRome = sql`chat_id = ${place.chat.id} AND thread_id IS ${place.threadId ?? null}
      AND sender_agent IS NOT NULL AND said_at > ${mark.at}`;
    const [row] = await this.db.all<{ count: number }>(sql`
      SELECT count(*) AS count FROM (SELECT 1 FROM ${CHAT_MESSAGES} WHERE ${fromRome} LIMIT ${cap})
    `);
    return Number(row?.count ?? 0);
  }
}

/** The turn a message is drawn under: its link's turn, or itself. */
function turnKey(message: SaidMessage, links: ReadonlyMap<number, TurnLink>): string {
  const link = links.get(message.id);
  return link?.turnId ? `turn:${link.sessionId}\0${link.turnId}` : `line:${message.id}`;
}

/** Whether `message` was said before the position `cursor` names. */
function before(message: SaidMessage, cursor: { at: Date; id: number }): boolean {
  const at = Math.floor(message.at.getTime() / 1000);
  const bound = Math.floor(cursor.at.getTime() / 1000);
  return at < bound || (at === bound && message.id < cursor.id);
}

function chatLine(
  message: SaidMessage,
  link: TurnLink | undefined,
  openedSessionId: string,
): TranscriptLine {
  const prompt = link?.role === "prompt";
  const accountId = message.saidBy?.account.id;
  // A dashboard source account is attribution, not a person an app can address.
  const sourceId =
    message.saidBy?.agent ??
    (accountId?.startsWith("automated::")
      ? accountId
      : accountId?.startsWith("agent:")
        ? accountId.slice(6)
        : undefined);
  const source =
    prompt && message.place.chat.platform === "webchat" ? automatedSource(sourceId) : null;
  return {
    id: message.key,
    sessionId: link?.sessionId ?? openedSessionId,
    turnId: link?.turnId ?? null,
    inputState: link?.inputState ?? null,
    role:
      message.direction === "fromRome" && !source ? "assistant" : prompt ? "user" : "notification",
    content: message.parts,
    senderAccountId: source ? null : (accountId ?? null),
    senderName: source ? "Automation" : (message.senderName ?? null),
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
