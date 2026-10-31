// Agents' link from a session's turns to the chat messages they took, gave
// and caught up on (`agent_turn_messages`). Vocabulary:
// docs/domains/agents.md and docs/domains/participation.md#projection.
//
// Chats answers a message's id when it records or sends one, and the link is
// written after, in a write of its own. A message carries no turn and a turn
// carries no message text.

import { sql } from "drizzle-orm";
import type { AgentInputState } from "@rome-os/app-runtime";
import type { DrizzleDb } from "../db/index.js";

/** What a message is to a session's turn: its prompt, its answer, or a line
 *  the turn caught up on. */
export type TurnLinkRole = "prompt" | "answer" | "seen";

/** One message's link to one session. `turnId` is null for a prompt still
 *  queued. `inputState` is set on a prompt alone. */
export interface TurnLink {
  readonly messageId: string;
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
  private readonly undecided = new Set<string>();

  constructor(private readonly db: DrizzleDb) {}

  /**
   * Make message `messageId` session `sessionId`'s prompt, for turn `turnId`
   * when it already runs and queued otherwise. A message the session caught
   * up on becomes its prompt. Safe to call again.
   */
  prompt(
    messageId: string,
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
    messageId: string,
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
  answer(messageId: string, sessionId: string, turnId: string): void {
    this.db.run(sql`
      INSERT INTO agent_turn_messages (message_id, session_id, turn_id, role, input_state)
      VALUES (${messageId}, ${sessionId}, ${turnId}, 'answer', NULL)
      ON CONFLICT (message_id, session_id) DO UPDATE SET role = 'answer', turn_id = excluded.turn_id
    `);
  }

  /** Mark `messageIds` caught up on by turn `turnId` of session `sessionId`.
   *  A message the session already linked keeps its link. */
  seen(messageIds: readonly string[], sessionId: string, turnId: string): void {
    if (messageIds.length === 0) return;
    this.db.run(sql`
      INSERT OR IGNORE INTO agent_turn_messages (message_id, session_id, turn_id, role, input_state)
      SELECT value, ${sessionId}, ${turnId}, 'seen', NULL
      FROM json_each(${JSON.stringify(messageIds)})
      WHERE value IN (SELECT id FROM chat_messages)
    `);
  }

  /** Each of `messageIds`' prompt or answer link, the first written when
   *  several sessions linked it. A message no turn took or gave is left out. */
  turnsOf(messageIds: readonly string[]): Map<string, TurnLink> {
    if (messageIds.length === 0) return new Map();
    const rows = this.db.all<LinkRow>(sql`
      SELECT message_id, session_id, turn_id, role, input_state
      FROM agent_turn_messages
      WHERE message_id IN (SELECT value FROM json_each(${JSON.stringify(messageIds)}))
        AND role IN ('prompt', 'answer')
      ORDER BY rowid
    `);
    const links = new Map<string, TurnLink>();
    for (const row of rows) if (!links.has(row.message_id)) links.set(row.message_id, toLink(row));
    return links;
  }

  /** The prompt and answer messages of turn `turnId` in session `sessionId`,
   *  in the order they were linked. */
  ofTurn(sessionId: string, turnId: string): TurnLink[] {
    return this.db
      .all<LinkRow>(sql`
        SELECT message_id, session_id, turn_id, role, input_state
        FROM agent_turn_messages
        WHERE session_id = ${sessionId} AND turn_id = ${turnId} AND role IN ('prompt', 'answer')
        ORDER BY rowid
      `)
      .map(toLink);
  }

  /** Session `sessionId`'s link to message `messageId`, or null for none. */
  linkOf(sessionId: string, messageId: string): TurnLink | null {
    const row = this.db.all<LinkRow>(sql`
      SELECT message_id, session_id, turn_id, role, input_state
      FROM agent_turn_messages
      WHERE session_id = ${sessionId} AND message_id = ${messageId}
    `)[0];
    return row ? toLink(row) : null;
  }

  /**
   * Session `sessionId`'s turns, the newest `limit` before `before` (every
   * turn without a limit), whole, oldest first, with the cursor of the turns
   * before them: for a session in a chat the messages its turns took and gave,
   * and for one with no chat (a subagent, a fork, a handoff) each turn's own
   * prompt and answer, beside each turn's trace. A line outside any turn is a
   * turn of its own. Turns order by their first line.
   */
  turns(
    sessionId: string,
    page: { before?: { at: number; id: string } | null; limit?: number } = {},
  ): { lines: TurnLine[]; older: { at: number; id: string } | null } {
    const { before, limit } = page;
    const rows = this.db.all<TurnRow>(sql`
      WITH lines AS (
        -- The turn's own rows Agents keeps: its trace, and with no chat its
        -- prompt and answer.
        SELECT t.id, t.turn_id, t.role, t.content, NULL AS input_state,
               NULL AS sender_account_id, t.sender_name, t.created_at AS at, t.rowid AS seq
        FROM rome_agent_messages t
        WHERE t.session_id = ${sessionId}
          AND (t.role = 'trace'
               OR (SELECT chat_id FROM rome_sessions WHERE id = ${sessionId}) IS NULL)
        UNION ALL
        -- In a chat, the messages its turns took and gave, through the link.
        SELECT m.id, l.turn_id,
               CASE WHEN m.sender_agent IS NOT NULL THEN 'assistant' ELSE 'user' END,
               m.parts, l.input_state, m.sender_account_id, m.sender_name, m.said_at, m.rowid
        FROM agent_turn_messages l JOIN chat_messages m ON m.id = l.message_id
        WHERE l.session_id = ${sessionId} AND l.role IN ('prompt', 'answer')
      ),
      keyed AS (
        SELECT *, coalesce(turn_id, id) AS key,
               MIN(at) OVER (PARTITION BY coalesce(turn_id, id)) AS started_at
        FROM lines
      ),
      turns AS (
        SELECT DISTINCT key, started_at FROM keyed
        ${before ? sql`WHERE (started_at, key) < (${before.at}, ${before.id})` : sql``}
        ORDER BY started_at DESC, key DESC
        ${limit === undefined ? sql`` : sql`LIMIT ${limit + 1}`}
      ),
      shown AS (
        SELECT key FROM turns ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}
      )
      SELECT keyed.*, (SELECT count(*) FROM turns) > ${limit ?? -1} AS more
      FROM keyed JOIN shown USING (key)
      ORDER BY keyed.started_at, keyed.key, keyed.at, keyed.seq
    `);
    const oldest = rows[0];
    return {
      lines: rows.map((row) => ({
        id: row.id,
        turnId: row.turn_id,
        role: row.role,
        content: row.content,
        inputState: row.input_state,
        senderAccountId: row.sender_account_id,
        senderName: row.sender_name,
        at: new Date(row.at * 1000),
      })),
      older: oldest?.more ? { at: oldest.started_at, id: oldest.key } : null,
    };
  }

  /**
   * The messages said where session `sessionId` stands since it started that
   * it has no link to, oldest first: what it has not seen. A message whose
   * wake is still undecided is left out, since it may yet become a turn's
   * prompt of its own. Each comes with the message it quotes, found anywhere
   * in its chat, so a thread's first line can carry the line that started it.
   */
  unseen(sessionId: string): UnseenLine[] {
    return this.db
      .all<UnseenRow>(sql`
        SELECT m.id, ${SENDER_NAME("m")} AS sender_name, m.sender_agent IS NOT NULL AS from_rome,
               m.text, m.said_at, q.id AS q_id, ${SENDER_NAME("q")} AS q_sender_name,
               q.text AS q_text, q.said_at AS q_said_at
        FROM rome_sessions s
        JOIN chat_messages m ON m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
        -- A quoted line said before Rome's account was in the chat stays out
        -- of its view, like every other line said then.
        LEFT JOIN chat_messages q ON q.id = m.reply_to_message_id
          AND q.said_at >= (
            SELECT min(o.created_at) FROM rome_sessions o
            WHERE o.chat_id = s.chat_id AND o.account_id IS s.account_id)
        WHERE s.id = ${sessionId} AND m.said_at >= s.created_at
          AND NOT EXISTS (
            SELECT 1 FROM agent_turn_messages l
            WHERE l.message_id = m.id AND l.session_id = s.id)
        ORDER BY m.said_at, m.rowid
      `)
      .filter((row) => !this.undecided.has(row.id))
      .map((row) => ({
        id: row.id,
        senderName: row.sender_name,
        fromRome: Boolean(row.from_rome),
        text: row.text,
        at: new Date(row.said_at * 1000),
        quoted:
          row.q_id === null
            ? null
            : {
                id: row.q_id,
                senderName: row.q_sender_name,
                text: row.q_text ?? "",
                at: new Date((row.q_said_at ?? 0) * 1000),
              },
      }));
  }

  /** Hold message `messageId` out of every catch-up until its wake is
   *  decided. */
  wakeUndecided(messageId: string): void {
    this.undecided.add(messageId);
  }

  /** Note that whether message `messageId` wakes an agent is decided. */
  wakeDecided(messageId: string): void {
    this.undecided.delete(messageId);
  }

  isWakeUndecided(messageId: string): boolean {
    return this.undecided.has(messageId);
  }
}

/** One line of a session's turns: a message a turn took or gave, a line of
 *  a session with no chat, or a turn's trace. */
export interface TurnLine {
  readonly id: string;
  readonly turnId: string | null;
  readonly role: "user" | "assistant" | "notification" | "trace";
  /** The line's parts as JSON; a trace's is its stub. */
  readonly content: string;
  readonly inputState: AgentInputState | null;
  readonly senderAccountId: string | null;
  readonly senderName: string | null;
  readonly at: Date;
}

interface TurnRow {
  id: string;
  turn_id: string | null;
  role: TurnLine["role"];
  content: string;
  input_state: AgentInputState | null;
  sender_account_id: string | null;
  sender_name: string | null;
  at: number;
  key: string;
  started_at: number;
  more: number;
}

/** A line said where a session stands, as it would read it. */
export interface ContextLine {
  readonly id: string;
  readonly senderName: string | null;
  readonly text: string;
  readonly at: Date;
}

/** A line the session has not seen, with the line it quotes. */
export interface UnseenLine extends ContextLine {
  readonly fromRome: boolean;
  readonly quoted: ContextLine | null;
}

interface UnseenRow {
  id: string;
  sender_name: string | null;
  from_rome: number;
  text: string;
  said_at: number;
  q_id: string | null;
  q_sender_name: string | null;
  q_text: string | null;
  q_said_at: number | null;
}

interface LinkRow {
  message_id: string;
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

/** What a line calls its sender. A line of Rome's that kept no name is
 *  Rome's, as the agent has always read it. */
function SENDER_NAME(alias: "m" | "q") {
  return sql.raw(
    `CASE WHEN ${alias}.sender_agent IS NOT NULL THEN coalesce(${alias}.sender_name, 'Rome') ELSE ${alias}.sender_name END`,
  );
}
