// The rows a session keeps of its turns, in the shapes Chats' own queries
// join. Chats draws a session's traces beside its messages, and counts them,
// in one query, so it gets the rows as SQL rather than through a call. This
// file and the log are the only places outside the schema that name the
// tables the rows live in.

import type { AgentInputState } from "@rome-os/app-runtime";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "../../db/index.js";
import { romeAgentMessages } from "../../db/schema/system.js";
import type { SessionActor } from "../../lib/session-actor.js";

/**
 * The turn rows of the sessions `sessionIds` names, as a table to select
 * from. `sessionIds` is a parenthesized list or subquery, such as
 * `(SELECT value FROM json_each(?))`, or `(s.id)` for the session of an
 * outer row. The columns are `id`, `session_id`, `turn_id`, `input_state`,
 * `role`, `is_trace`, `content`, `actor`, `sender_id`, `created_at`, and
 * `seq`, which orders the rows as they were written.
 */
export function turnRowsOf(sessionIds: SQL): SQL {
  return sql`(SELECT r.id, r.session_id, r.turn_id, r.input_state, r.role,
      r.role = 'trace' AS is_trace, r.content, r.actor, r.sender_id, r.created_at,
      r.rowid AS seq
    FROM ${romeAgentMessages} r WHERE r.session_id IN ${sessionIds})`;
}

/** A prompt or answer the session kept, with who gave it. */
export interface KeptTurnMessage {
  id: string;
  turnId: string | null;
  role: "user" | "assistant";
  content: string;
  actor: SessionActor | null;
  inputState: AgentInputState | null;
  createdAt: Date;
}

/** The prompts and answers session `sessionId` kept, in the order it kept
 *  them. Synchronous, so a write that copies them can run in one transaction. */
export function keptTurnMessagesOf(
  db: DrizzleDb | DrizzleTx,
  sessionId: string,
): KeptTurnMessage[] {
  return db
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
        eq(romeAgentMessages.sessionId, sessionId),
        inArray(romeAgentMessages.role, ["user", "assistant"]),
      ),
    )
    .orderBy(asc(romeAgentMessages.createdAt), sql`${romeAgentMessages}.rowid`)
    .all() as KeptTurnMessage[];
}

/** Where the prompt `inputId` that session `sessionId` kept stands: the turn
 *  it ran in, if any, and its input state. Undefined when it kept no such
 *  prompt. */
export async function keptInputOf(
  db: DrizzleDb,
  sessionId: string,
  inputId: string,
): Promise<{ turnId: string | null; inputState: AgentInputState | null } | undefined> {
  return db
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
