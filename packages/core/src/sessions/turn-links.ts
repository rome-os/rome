// Agents' link from a session's turns to the chat messages they took, gave
// and caught up on (`agent_turn_messages`). Vocabulary:
// docs/domains/agents.md and docs/domains/participation.md#projection.
//
// Chats answers a message's id when it records or sends one, and the link is
// written after, in a write of its own. A message carries no turn and a turn
// carries no message text. Nothing calls this yet: the Chats switch moves
// Agents' catch-up and turn writes onto it.

import { and, eq, isNull, min, sql } from "drizzle-orm";
import type { AgentInputState, ChatId } from "@rome-os/app-runtime";
import type { DrizzleDb } from "../db/index.js";
import { ChatRepository } from "../chats/storage/chat-repository.js";
import { MessageRepository } from "../chats/storage/message-repository.js";
import { romeSessions } from "../db/schema/system.js";
import { chatKey, ownedBy } from "../connections/chat-ids.js";
import type { SaidMessage } from "../chats/storage/message.js";

/** What a message is to a session's turn: its prompt, its answer, or a line
 *  the turn caught up on. */
export type TurnLinkRole = "prompt" | "answer" | "seen";

/** One message's link to one session. `turnId` is null for a prompt still
 *  queued. `inputState` is set on a prompt alone. */
export interface TurnLink {
  readonly messageId: number;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly role: TurnLinkRole;
  readonly inputState: AgentInputState | null;
}

export class TurnLinks {
  /**
   * The messages whose wake is still being decided. Kept in memory: a
   * restart forgets it, which decides every wake in flight, since the
   * decision died with the process.
   */
  private readonly undecided = new Set<number>();

  /** Chats' reads, which every line a session reads goes through. */
  private readonly messages: Pick<MessageRepository, "read" | "byIds">;

  /** Chats' chats, where a seat's chat is found. */
  private readonly chats: Pick<ChatRepository, "find">;

  constructor(
    private readonly db: DrizzleDb,
    messages?: Pick<MessageRepository, "read" | "byIds">,
  ) {
    this.messages = messages ?? new MessageRepository(db);
    this.chats = new ChatRepository(db);
  }

  /** Where session `sessionId` stands, from its own row, or null for a
   *  session in no chat. */
  private seatOf(sessionId: string): {
    chatId: number;
    platform: string;
    threadId: string | null;
    since: Date;
    joined: Date;
    /** Whether the chat numbers its messages per member account, so each of
     *  Rome's accounts there holds its own copy of a message. */
    perAccount: boolean;
  } | null {
    const row = this.db
      .select({
        chatId: romeSessions.chatId,
        threadId: romeSessions.threadId,
        accountId: romeSessions.accountId,
        createdAt: romeSessions.createdAt,
      })
      .from(romeSessions)
      .where(eq(romeSessions.id, sessionId))
      .get();
    const chat = row?.chatId ? this.chats.find(row.chatId) : null;
    if (!row || !chat) return null;
    // When the account first took a seat in the chat, in any of its threads.
    const first = this.db
      .select({ at: min(romeSessions.createdAt) })
      .from(romeSessions)
      .where(
        and(
          eq(romeSessions.chatId, chat.ref.id),
          row.accountId === null
            ? isNull(romeSessions.accountId)
            : eq(romeSessions.accountId, row.accountId),
        ),
      )
      .get();
    return {
      chatId: chat.ref.id,
      platform: chat.ref.platform,
      threadId: row.threadId,
      since: row.createdAt,
      joined: first?.at ?? row.createdAt,
      perAccount: ownedBy(chatKey(chat.ref.platform, chat.key as ChatId), "_", "") !== "",
    };
  }

  /**
   * Make message `messageId` session `sessionId`'s prompt, for turn `turnId`
   * when it already runs and queued otherwise. A message the session caught
   * up on becomes its prompt. Safe to call again.
   */
  prompt(
    messageId: number,
    sessionId: string,
    turnId: string | null = null,
    inputState: AgentInputState | null = null,
  ): void {
    this.db.run(sql`
      INSERT INTO agent_turn_messages (message_id, session_id, turn_id, role, input_state)
      VALUES (${messageId}, ${sessionId}, ${turnId}, 'prompt', ${inputState})
      ON CONFLICT (message_id, session_id) DO UPDATE SET
        role = 'prompt',
        -- A line only caught up on becomes a prompt of its own turn, queued
        -- when it names none; a prompt keeps the turn it already runs.
        turn_id = CASE WHEN agent_turn_messages.role = 'prompt'
          THEN coalesce(excluded.turn_id, agent_turn_messages.turn_id)
          ELSE excluded.turn_id END,
        input_state = coalesce(excluded.input_state, agent_turn_messages.input_state)
    `);
  }

  /** The turn session `sessionId` runs for its prompt `messageId`, and where
   *  the input stands. Changes nothing when the message is not its prompt. */
  promptRuns(
    sessionId: string,
    messageId: number,
    turnId: string | null,
    inputState?: AgentInputState,
  ): void {
    this.db.run(sql`
      UPDATE agent_turn_messages SET
        turn_id = coalesce(${turnId}, turn_id),
        input_state = coalesce(${inputState ?? null}, input_state)
      WHERE session_id = ${sessionId} AND message_id = ${messageId} AND role = 'prompt'
    `);
  }

  /** Every queued or running prompt's input, across sessions, marked as
   *  unknown: a stopped process can no longer say how it stands. */
  forgetInputsInFlight(): void {
    this.db.run(sql`
      UPDATE agent_turn_messages SET input_state = 'unknown'
      WHERE input_state IN ('queued', 'submitted', 'accepted')
    `);
  }

  /** Make message `messageId` turn `turnId`'s answer in session `sessionId`.
   *  Safe to call again. */
  answer(messageId: number, sessionId: string, turnId: string): void {
    this.db.run(sql`
      INSERT INTO agent_turn_messages (message_id, session_id, turn_id, role, input_state)
      VALUES (${messageId}, ${sessionId}, ${turnId}, 'answer', NULL)
      ON CONFLICT (message_id, session_id) DO UPDATE SET role = 'answer', turn_id = excluded.turn_id
    `);
  }

  /** Mark `messageIds` caught up on by turn `turnId` of session `sessionId`.
   *  A message the session already linked keeps its link. */
  seen(messageIds: readonly number[], sessionId: string, turnId: string): void {
    // Only messages Chats holds: one gone since is nothing to link.
    const held = this.messages.byIds(messageIds).map((message) => message.id);
    if (held.length === 0) return;
    this.db.run(sql`
      INSERT OR IGNORE INTO agent_turn_messages (message_id, session_id, turn_id, role, input_state)
      SELECT value, ${sessionId}, ${turnId}, 'seen', NULL
      FROM json_each(${JSON.stringify(held)})
    `);
  }

  /** Each of `messageIds`' prompt or answer link, the first written when
   *  several sessions linked it. A message no turn took or gave is left out. */
  turnsOf(messageIds: readonly number[]): Map<number, TurnLink> {
    if (messageIds.length === 0) return new Map();
    const rows = this.db.all<LinkRow>(sql`
      SELECT message_id, session_id, turn_id, role, input_state
      FROM agent_turn_messages
      WHERE message_id IN (SELECT value FROM json_each(${JSON.stringify(messageIds)}))
        AND role IN ('prompt', 'answer')
      ORDER BY rowid
    `);
    const links = new Map<number, TurnLink>();
    for (const row of rows) if (!links.has(row.message_id)) links.set(row.message_id, toLink(row));
    return links;
  }

  /** Session `sessionId`'s link to message `messageId`, or null for none. */
  linkOf(sessionId: string, messageId: number): TurnLink | null {
    const row = this.db.all<LinkRow>(sql`
      SELECT message_id, session_id, turn_id, role, input_state
      FROM agent_turn_messages
      WHERE session_id = ${sessionId} AND message_id = ${messageId}
    `)[0];
    return row ? toLink(row) : null;
  }

  /**
   * The messages said where session `sessionId` stands since it started that
   * it has no link to, oldest first: what it has not seen. A message whose
   * wake is still undecided is left out, since it may yet become a turn's
   * prompt of its own. Each comes with the message it quotes, found anywhere
   * in its chat, so a thread's first line can carry the line that started it.
   * A copy of a line it saw, held by another of Rome's accounts, is linked as
   * seen on the way, with no turn. A copy of an undecided line waits with it.
   */
  unseen(sessionId: string): UnseenLine[] {
    const seat = this.seatOf(sessionId);
    if (!seat) return [];
    // A line said in the second the seat started may have come before it, so
    // only lines said after that second are the seat's to catch up on. Only
    // ids are read here, so a long history the session has seen costs an
    // index scan rather than every line's text.
    const where = sql`m.chat_id = ${seat.chatId} AND m.thread_id IS ${seat.threadId}`;
    const fresh = this.db
      .all<{ id: number; said_at: number }>(sql`
        SELECT m.id, m.said_at FROM chat_messages m
        WHERE ${where} AND m.said_at > ${Math.floor(seat.since.getTime() / 1000)}
          AND NOT EXISTS (
            SELECT 1 FROM agent_turn_messages l
            WHERE l.message_id = m.id AND l.session_id = ${sessionId}
          )
      `)
      .filter((row) => !this.undecided.has(row.id));
    if (fresh.length === 0) return [];
    // A chat that numbers messages per member account holds one copy of a
    // message for each of Rome's accounts that heard it; no other chat holds
    // copies. The session has
    // seen every copy of a message it has seen one of, and reads one copy of
    // the rest. Copies share their second, so the lines said in the seconds
    // of the fresh ones are every copy any of them can have.
    const seconds = [...new Set(fresh.map((row) => row.said_at))];
    const said = this.messages.byIds(
      this.db
        .all<{ id: number }>(sql`
          SELECT m.id FROM chat_messages m
          WHERE ${where} AND m.said_at IN (SELECT value FROM json_each(${JSON.stringify(seconds)}))
        `)
        .map((row) => row.id),
    );
    const unread = new Set(fresh.map((row) => row.id));
    // Only a line the session has a link to is one it saw. A line out of
    // `fresh` may instead be undecided, and then every copy of it waits with
    // it, unlinked, until its wake is decided.
    const linked = new Set(
      this.db
        .all<{ message_id: number }>(sql`
          SELECT message_id FROM agent_turn_messages
          WHERE session_id = ${sessionId}
            AND message_id IN (SELECT value FROM json_each(${JSON.stringify(said.map((m) => m.id))}))
        `)
        .map((row) => row.message_id),
    );
    const copies = new Copies(seat.perAccount ? said : []);
    const waiting = new Copies(seat.perAccount ? said : []);
    for (const message of said) {
      if (linked.has(message.id)) copies.take(message);
      else if (this.undecided.has(message.id)) waiting.take(message);
    }
    for (const message of said) if (waiting.heardBefore(message)) unread.delete(message.id);
    // A copy of a line the session saw is seen with it. Linking it so means
    // the next catch-up does not read it again.
    const seenCopies = said.filter(
      (message) => unread.has(message.id) && copies.heardBefore(message),
    );
    if (seenCopies.length > 0) {
      for (const message of seenCopies) unread.delete(message.id);
      this.db.run(sql`
        INSERT OR IGNORE INTO agent_turn_messages (message_id, session_id, turn_id, role, input_state)
        SELECT value, ${sessionId}, NULL, 'seen', NULL
        FROM json_each(${JSON.stringify(seenCopies.map((message) => message.id))})
      `);
    }
    const lines = said.filter((message) => {
      if (!unread.has(message.id)) return false;
      if (copies.heardBefore(message)) return false;
      copies.take(message);
      return true;
    });
    // A quoted line said before Rome's account was in the chat stays out of
    // its view, like every other line said then.
    const quoted = new Map(
      this.messages
        .byIds(lines.flatMap((message) => (message.replyTo ? [message.replyTo] : [])))
        .filter((message) => message.at > seat.joined)
        .map((message) => [message.id, contextOf(message)]),
    );
    return lines.map((message) => ({
      ...contextOf(message),
      fromRome: message.direction === "fromRome",
      quoted: (message.replyTo && quoted.get(message.replyTo)) || null,
    }));
  }

  /** Hold message `messageId` out of every catch-up until its wake is
   *  decided. */
  wakeUndecided(messageId: number): void {
    this.undecided.add(messageId);
  }

  /** Note that whether message `messageId` wakes an agent is decided. */
  wakeDecided(messageId: number): void {
    this.undecided.delete(messageId);
  }
}

/** A line said where a session stands, as it would read it. */
export interface ContextLine {
  readonly id: number;
  readonly senderName: string | null;
  readonly text: string;
  readonly at: Date;
}

/** A line the session has not seen, with the line it quotes. */
export interface UnseenLine extends ContextLine {
  readonly fromRome: boolean;
  readonly quoted: ContextLine | null;
}

interface LinkRow {
  message_id: number;
  session_id: string;
  turn_id: string | null;
  role: TurnLinkRole;
  input_state: AgentInputState | null;
}

function toLink(row: LinkRow): TurnLink {
  return {
    messageId: row.message_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    role: row.role,
    inputState: row.input_state,
  };
}

/**
 * The copies of one message that two of Rome's accounts heard in a chat that
 * numbers messages per member account (a Telegram basic group). There each
 * key carries the account that holds it in front (`<account>:<id>`), and
 * copies share their sender, time and words. Two lines held by the same
 * account, or keyed by no account, are never copies, however alike. Where
 * one sender said the same words twice in a second, each account holds two
 * lines, and the nth line one account holds is a copy of the nth another
 * holds.
 */
class Copies {
  /** Each per-account line's message, as its holder's nth line alike. */
  private readonly occurrence = new Map<number, string>();
  private readonly taken = new Set<string>();

  /** The copies among `said`, in the order said. */
  constructor(said: readonly SaidMessage[]) {
    const seen = new Map<string, number>();
    for (const message of said) {
      const holder = holderOf(message);
      if (holder === null) continue;
      const copy = copyOf(message);
      const nth = seen.get(`${holder}\n${copy}`) ?? 0;
      seen.set(`${holder}\n${copy}`, nth + 1);
      this.occurrence.set(message.id, `${nth}\n${copy}`);
    }
  }

  /** Note that the session reads, or has read, `message`. */
  take(message: SaidMessage): void {
    const occurrence = this.occurrence.get(message.id);
    if (occurrence !== undefined) this.taken.add(occurrence);
  }

  /** Whether the session already took a copy of `message` another account
   *  holds. An account holds one line of each occurrence, so a copy taken is
   *  another account's. */
  heardBefore(message: SaidMessage): boolean {
    const occurrence = this.occurrence.get(message.id);
    return occurrence !== undefined && this.taken.has(occurrence);
  }
}

/** The account a per-account key names in front, or null for any other key. */
function holderOf(message: SaidMessage): string | null {
  const at = message.key.indexOf(":");
  return at > 0 ? message.key.slice(0, at) : null;
}

/** What the copies of one message share: its sender, its time and its words.
 *  An attachment's line names the file and where the account that heard it
 *  saved it, both of which the receiving account may choose, so only its
 *  kind and caption count. */
function copyOf(message: SaidMessage): string {
  return [
    message.saidBy?.account.id ?? message.saidBy?.agent ?? "",
    message.at.getTime(),
    message.body.text.replace(ATTACHMENT_FILE, "$1)"),
  ].join("\n");
}

/** The file name and path in an attachment's line of a message's text
 *  (`plainText`), after its kind and before any caption. */
const ATTACHMENT_FILE = /^(Attachment \d+ \(\w+)[^\n]*?\) path: [^\n]*?(?= caption: |$)/gm;

/** `message` as a session reads it. */
export function contextOf(message: SaidMessage): ContextLine {
  return {
    id: message.id,
    senderName: message.senderName ?? (message.direction === "fromRome" ? "Rome" : null),
    text: message.body.text,
    at: message.at,
  };
}
