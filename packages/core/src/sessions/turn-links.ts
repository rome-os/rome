// Agents' link from a session's turns to the chat messages they took, gave
// and caught up on (`agent_turn_messages`). Vocabulary:
// docs/domains/agents.md and docs/domains/participation.md#projection.
//
// Chats answers a message's id when it records or sends one, and the link is
// written after, in a write of its own. A message carries no turn and a turn
// carries no message text.

import { and, eq, isNull, min, sql } from "drizzle-orm";
import type { AgentInputState, ChatId } from "@rome-os/app-runtime";
import type { DrizzleDb } from "../db/index.js";
import { ChatRepository } from "../chats/chat-repository.js";
import { MessageRepository } from "../chats/message-repository.js";
import { romeSessions } from "../db/schema/system.js";
import type { SaidMessage } from "../chats/message.js";
import { placeIn } from "../chats/place.js";

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
    };
  }

  /** The ids of every message session `sessionId` links, and how. */
  private linksOf(sessionId: string): LinkRow[] {
    return this.db.all<LinkRow>(sql`
      SELECT message_id, session_id, turn_id, role, input_state
      FROM agent_turn_messages WHERE session_id = ${sessionId}
      ORDER BY rowid
    `);
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
        turn_id = coalesce(excluded.turn_id, agent_turn_messages.turn_id),
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
   */
  unseen(sessionId: string): UnseenLine[] {
    const seat = this.seatOf(sessionId);
    if (!seat) return [];
    const linked = new Set(this.linksOf(sessionId).map((link) => link.message_id));
    // A line said in the second the seat started may have come before it, so
    // only lines said after that second are the seat's to catch up on.
    const said = this.messages.read(
      placeIn(
        { platform: seat.platform, id: seat.chatId },
        (seat.threadId ?? undefined) as ChatId | undefined,
      ),
      { after: { at: seat.since } },
    ).messages;
    // A chat that numbers messages per member account holds one copy of a
    // message for each of Rome's accounts that heard it. The session has
    // seen every copy of a message it has seen one of, and reads one copy of
    // the rest.
    const seen = new Set(
      said
        .filter((message) => linked.has(message.id) || this.undecided.has(message.id))
        .map(copyOf),
    );
    const lines = said.filter((message) => {
      const copy = copyOf(message);
      if (seen.has(copy)) return false;
      seen.add(copy);
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

/** A message as a session reads it. A line of Rome's that kept no name is
 *  Rome's, as the agent has always read it. */
/** What the copies of one message heard on two of Rome's accounts share:
 *  its sender, its time and its words. */
function copyOf(message: SaidMessage): string {
  return [
    message.saidBy?.account.id ?? message.saidBy?.agent ?? "",
    message.at.getTime(),
    message.body.text,
  ].join("\n");
}

/** `message` as a session reads it. */
export function contextOf(message: SaidMessage): ContextLine {
  return {
    id: message.id,
    senderName: message.senderName ?? (message.direction === "fromRome" ? "Rome" : null),
    text: message.body.text,
    at: message.at,
  };
}
