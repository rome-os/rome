import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "../../db/index.js";
import {
  chatOutputBackfills,
  chatOutputs,
  romeAgentTraceBlocks,
  romeSessions,
} from "../../db/schema.js";
import {
  assetUrlsIn,
  mayHoldOutputs,
  outputsInMessage,
  outputsInTrace,
  type OutputFound,
} from "./trace-outputs.js";

export type ChatOutputRow = typeof chatOutputs.$inferSelect;

/** A stored message of a chat, as its transcript reads it. */
export interface BackfillMessage {
  id: string;
  turnId?: string | null;
  role: string;
  content: string;
  createdAt: Date;
}

/** Where an output was recorded: its chat, turn and message. */
export interface OutputPlace {
  sessionId: string;
  turnId: string | null;
  messageId: string | null;
}

type Writer = Pick<DrizzleDb, "insert" | "select">;

function insertOutputs(db: Writer, place: OutputPlace, found: OutputFound[], at: Date): void {
  if (found.length === 0) return;
  db.insert(chatOutputs)
    .values(
      found.map((output) => ({
        id: randomUUID(),
        sessionId: place.sessionId,
        turnId: place.turnId,
        messageId: place.messageId,
        sourceKey: output.sourceKey,
        kind: output.kind,
        path: output.path,
        sourcePath: output.sourcePath,
        name: output.name,
        mimeType: output.mimeType,
        createdAt: at,
      })),
    )
    .onConflictDoNothing({ target: [chatOutputs.sessionId, chatOutputs.sourceKey] })
    .run();
}

/** The tool call `toolUseId` of trace message `messageId`, from the blocks already stored. */
function storedToolUse(db: Writer, messageId: string, toolUseId: string) {
  const row = db
    .select({ content: romeAgentTraceBlocks.content })
    .from(romeAgentTraceBlocks)
    .where(
      and(
        eq(romeAgentTraceBlocks.messageId, messageId),
        sql`json_extract(${romeAgentTraceBlocks.content}, '$.type') = 'tool_use'`,
        sql`json_extract(${romeAgentTraceBlocks.content}, '$.id') = ${toolUseId}`,
      ),
    )
    .get();
  if (!row) return null;
  try {
    return JSON.parse(row.content) as { type: "tool_use"; id?: string; tool?: string };
  } catch {
    return null;
  }
}

/**
 * Records the outputs a stretch of trace `messageId` made, in the transaction
 * that stores the stretch, so an output is recorded exactly when its trace is.
 * A result whose call an earlier stretch stored finds it there.
 */
export function recordTraceOutputs(
  tx: DrizzleTx,
  place: OutputPlace & { messageId: string },
  blocks: readonly unknown[],
  at: Date,
): void {
  if (!mayHoldOutputs(blocks)) return;
  const found = outputsInTrace(blocks, (id) => storedToolUse(tx, place.messageId, id));
  insertOutputs(tx, place, found, at);
}

export class ChatOutputsRepository {
  constructor(private db: DrizzleDb) {}

  /** Every record of chats `sessionIds`, newest first. */
  async listFor(sessionIds: readonly string[]): Promise<ChatOutputRow[]> {
    if (sessionIds.length === 0) return [];
    return (
      this.db
        .select()
        .from(chatOutputs)
        .where(inArray(chatOutputs.sessionId, [...sessionIds]))
        // rowid breaks a tie in the order the records were made.
        .orderBy(desc(chatOutputs.createdAt), desc(sql`rowid`))
    );
  }

  /**
   * The subagent sessions under chats `sessionIds`, at any depth: their
   * agent's helpers, whose work is the chat's.
   */
  async subagentsOf(sessionIds: readonly string[]): Promise<string[]> {
    const found: string[] = [];
    let parents = [...sessionIds];
    const seen = new Set(parents);
    while (parents.length > 0) {
      const rows = await this.db
        .select({ id: romeSessions.id })
        .from(romeSessions)
        .where(
          and(inArray(romeSessions.parentSessionId, parents), eq(romeSessions.type, "subagent")),
        );
      parents = rows.map((row) => row.id).filter((id) => !seen.has(id));
      for (const id of parents) seen.add(id);
      found.push(...parents);
    }
    return found;
  }

  async get(id: string): Promise<ChatOutputRow | null> {
    return (await this.db.select().from(chatOutputs).where(eq(chatOutputs.id, id)))[0] ?? null;
  }

  /** Whether chat `sessionId`'s earlier outputs were read back. */
  backfilled(sessionId: string): boolean {
    return Boolean(
      this.db
        .select({ id: chatOutputBackfills.sessionId })
        .from(chatOutputBackfills)
        .where(eq(chatOutputBackfills.sessionId, sessionId))
        .get(),
    );
  }

  /**
   * Reads back what chat `sessionId` made before outputs were recorded, from
   * its `messages`: the write and show calls its stored traces still hold,
   * and the asset links its agent's messages hold that no guardian message
   * attached. An output already recorded is not recorded again, so a second
   * read back changes nothing.
   */
  backfill(sessionId: string, messages: readonly BackfillMessage[], now = new Date()): void {
    this.db.transaction((tx) => {
      const attached = new Set(
        messages
          .filter((message) => message.role === "user")
          .flatMap((message) => assetUrlsIn(message.content)),
      );
      for (const message of messages) {
        const place = { sessionId, turnId: message.turnId ?? null, messageId: message.id };
        if (message.role === "assistant") {
          const shown = outputsInMessage(message.id, message.content).filter(
            (output) => !attached.has(output.path),
          );
          insertOutputs(tx, place, shown, message.createdAt);
        } else if (message.role === "trace") {
          const found = this.traceOutputs(tx, message.id, message.content);
          insertOutputs(tx, place, found, message.createdAt);
        }
      }
      tx.insert(chatOutputBackfills)
        .values({ sessionId, backfilledAt: now })
        .onConflictDoNothing()
        .run();
    });
  }

  /** A stored trace's outputs: its block rows, else the whole trace kept on its message row. */
  private traceOutputs(tx: DrizzleTx, messageId: string, content: string): OutputFound[] {
    const rows = tx
      .select({ content: romeAgentTraceBlocks.content })
      .from(romeAgentTraceBlocks)
      .where(
        and(
          eq(romeAgentTraceBlocks.messageId, messageId),
          sql`json_extract(${romeAgentTraceBlocks.content}, '$.type') IN ('tool_use', 'tool_result')`,
        ),
      )
      .orderBy(asc(romeAgentTraceBlocks.seq))
      .all();
    const blocks: unknown[] = [];
    if (rows.length > 0) {
      for (const row of rows) {
        try {
          blocks.push(JSON.parse(row.content));
        } catch {
          // A block that does not parse made no output.
        }
      }
    } else {
      try {
        const legacy = JSON.parse(content);
        if (Array.isArray(legacy)) blocks.push(...legacy);
      } catch {
        return [];
      }
    }
    return outputsInTrace(blocks);
  }

  /** Removes chats' outputs with the chats, in their delete's transaction. */
  static deleteIn(tx: DrizzleTx, sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    tx.delete(chatOutputs)
      .where(inArray(chatOutputs.sessionId, [...sessionIds]))
      .run();
    tx.delete(chatOutputBackfills)
      .where(inArray(chatOutputBackfills.sessionId, [...sessionIds]))
      .run();
  }
}
