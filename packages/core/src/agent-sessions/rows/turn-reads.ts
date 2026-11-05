// What Sessions reads back of its turns: their traces, and the prompts and
// answers a session in no chat keeps beside them. Turns and traces are
// Sessions', so every reader outside reads them here. Today they live in
// rome_agent_messages and rome_agent_trace_blocks, under the conversation
// the log kept each turn in.

import type { SessionTrace } from "@rome-os/app-runtime/chats";
import type { AgentInputState } from "@rome-os/app-runtime";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import type { TraceReadOptions, WebChatRepository } from "../../db/repositories/webchat.js";
import { romeAgentMessages } from "../../db/schema/system.js";

/** A turn of a session, named by the conversation it was kept in. */
export interface TurnRef {
  sessionId: string;
  turnId: string;
}

/** Where a turn's trace is kept, without its blocks. */
export interface TraceHead extends TurnRef {
  id: string;
  createdAt: Date;
}

/** A prompt or answer, or a message outside any turn, that a session in no
 *  chat keeps beside its traces. */
export interface KeptMessage {
  id: string;
  turnId: string | null;
  inputState: AgentInputState | null;
  role: "user" | "assistant" | "notification";
  content: string;
  senderName: string | null;
  createdAt: Date;
}

export interface KeptTurnsPage {
  /** Turns per page. */
  limit: number;
  before?: { at: number; id: string } | null;
}

export interface KeptTurns {
  messages: KeptMessage[];
  traces: TraceHead[];
  nextCursor: { at: number; id: string } | null;
}

type TraceRepo = Pick<
  WebChatRepository,
  | "getTraceContents"
  | "getTraceContentByTurn"
  | "getTraceContentsByTurns"
  | "getMessageContentForDisplay"
>;

export interface TurnReads {
  /** The traces of conversation `conversationId`, oldest first. */
  traces(
    conversationId: string,
    options?: TraceReadOptions,
  ): ReturnType<WebChatRepository["getTraceContents"]>;
  /** The trace of one turn. */
  trace(
    conversationId: string,
    turnId: string,
    options?: TraceReadOptions,
  ): ReturnType<WebChatRepository["getTraceContentByTurn"]>;
  /** The traces of each of `turns` that has one. */
  tracesOf(
    turns: readonly TurnRef[],
    options?: TraceReadOptions,
  ): ReturnType<WebChatRepository["getTraceContentsByTurns"]>;
  /** A trace by its own id. */
  traceById(
    id: string,
    options?: TraceReadOptions,
  ): ReturnType<WebChatRepository["getMessageContentForDisplay"]>;
  /** Where each of `turns` keeps its trace, without loading its blocks. */
  traceHeadsOf(turns: readonly TurnRef[]): Promise<TraceHead[]>;
  /** The traces of conversation `conversationId`, oldest first, each with its
   *  blocks put back together and what its turn used. */
  tracesWithUsage(conversationId: string): Promise<SessionTrace[]>;
  /**
   * The turns of a session that stands in no chat (a subagent, a fork, a
   * handoff), from the prompts, answers and traces it keeps itself: the
   * newest `page.limit` before `page.before` (every turn without a page),
   * whole, oldest first. A turn stands where its first message was said, and
   * a message outside any turn is a turn of its own.
   */
  keptTurns(sessionId: string, page?: KeptTurnsPage): Promise<KeptTurns>;
}

/** Sessions' reads of its turns. A reader built without `repo` reads only
 *  what it keeps without the trace blocks: heads and kept turns. */
export function createTurnReads(db: DrizzleDb, traceRepo?: TraceRepo): TurnReads {
  const repo = traceRepo ?? noTraceRepo;
  return {
    traces: (conversationId, options) => repo.getTraceContents(conversationId, options),
    trace: (conversationId, turnId, options) =>
      repo.getTraceContentByTurn(conversationId, turnId, options),
    tracesOf: (turns, options) => repo.getTraceContentsByTurns(turns, options),
    traceById: (id, options) => repo.getMessageContentForDisplay(id, options),
    traceHeadsOf: (turns) => traceHeadsOf(db, turns),
    async tracesWithUsage(conversationId) {
      const stubs = db
        .select({
          id: romeAgentMessages.id,
          turnId: romeAgentMessages.turnId,
          createdAt: romeAgentMessages.createdAt,
          inputTokens: romeAgentMessages.inputTokens,
          outputTokens: romeAgentMessages.outputTokens,
          cacheReadTokens: romeAgentMessages.cacheReadTokens,
          cacheWriteTokens: romeAgentMessages.cacheWriteTokens,
          costUsd: romeAgentMessages.costUsd,
        })
        .from(romeAgentMessages)
        .where(
          and(eq(romeAgentMessages.sessionId, conversationId), eq(romeAgentMessages.role, "trace")),
        )
        .orderBy(asc(romeAgentMessages.createdAt), asc(romeAgentMessages.id))
        .all();
      if (stubs.length === 0) return [];
      const contents = new Map(
        (await repo.getTraceContents(conversationId)).map((trace) => [trace.id, trace.content]),
      );
      return stubs.map((stub) => ({ ...stub, content: contents.get(stub.id) ?? "[]" }));
    },
    keptTurns: (sessionId, page) => keptTurns(db, sessionId, page),
  };
}

const noTrace = (): never => {
  throw new Error("This turn reader reads no trace blocks");
};
const noTraceRepo: TraceRepo = {
  getTraceContents: noTrace,
  getTraceContentByTurn: noTrace,
  getTraceContentsByTurns: noTrace,
  getMessageContentForDisplay: noTrace,
};

async function traceHeadsOf(db: DrizzleDb, refs: readonly TurnRef[]): Promise<TraceHead[]> {
  const turns = new Map<string, TurnRef>();
  for (const ref of refs) turns.set(JSON.stringify([ref.sessionId, ref.turnId]), ref);
  if (turns.size === 0) return [];
  // The turns go in as one JSON value, so a long history binds one
  // parameter however many turns it shows.
  const wanted = JSON.stringify([...turns.values()].map((turn) => [turn.sessionId, turn.turnId]));
  const rows = await db.all<{
    id: string;
    session_id: string;
    turn_id: string;
    created_at: number;
  }>(sql`
    WITH wanted(session_id, turn_id) AS (
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(${wanted})
    )
    SELECT t.id, t.session_id, t.turn_id, t.created_at
    -- CROSS JOIN keeps the wanted turns outside, so each finds its trace
    -- by turn id. Left to choose, SQLite walks every trace in the database
    -- and scans the wanted list for each.
    FROM wanted w
    CROSS JOIN rome_agent_messages t
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

async function keptTurns(
  db: DrizzleDb,
  sessionId: string,
  page?: KeptTurnsPage,
): Promise<KeptTurns> {
  const before = page?.before ?? null;
  const rows = await db.all<{
    id: string;
    turn_id: string | null;
    input_state: AgentInputState | null;
    role: KeptMessage["role"] | "trace";
    content: string;
    sender_name: string | null;
    at: number;
    turn: string;
    turn_at: number;
  }>(sql`
    WITH line AS (
      -- A trace's blocks load only when the guardian opens it.
      SELECT id, turn_id, input_state, role,
        CASE WHEN role = 'trace' THEN '[]' ELSE content END AS content,
        json_extract(actor, '$.email') AS sender_name,
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
  const messages: KeptMessage[] = [];
  const traces: TraceHead[] = [];
  for (const row of shown) {
    const createdAt = new Date(row.at * 1000);
    if (row.role !== "trace") {
      messages.push({
        id: row.id,
        turnId: row.turn_id,
        inputState: row.input_state,
        role: row.role,
        content: row.content,
        senderName: row.sender_name,
        createdAt,
      });
    } else if (row.turn_id !== null) {
      traces.push({ id: row.id, sessionId, turnId: row.turn_id, createdAt });
    }
  }
  const oldest = shown[0];
  return {
    messages,
    traces,
    nextCursor: more && oldest ? { at: oldest.turn_at, id: oldest.turn } : null,
  };
}
