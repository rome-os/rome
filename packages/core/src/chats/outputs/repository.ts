import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "../../db/index.js";
import { createLogger } from "../../logger.js";
import { getProjectsRoot } from "../../paths.js";
import {
  chatOutputBackfills,
  chatOutputs,
  romeAgentTraceBlocks,
  romeSessions,
  settings,
} from "../../db/schema.js";
import {
  assetUrlsIn,
  isOutputCall,
  mayHoldOutputs,
  outputsInMessage,
  outputsInTrace,
  type OutputFound,
  type OutputScope,
  type ToolUseBlock,
} from "./trace-outputs.js";

const log = createLogger("chat-outputs");

export type ChatOutputRow = typeof chatOutputs.$inferSelect;

/** The setting that holds when outputs began to be recorded as they happen. */
const RECORDING_SINCE_KEY = "chatOutputs.recordingSince";

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

/** The files on this machine, as a shell command or a reply names them. */
function localFiles(): OutputScope {
  return {
    projectsRoot: getProjectsRoot(),
    isFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
  };
}

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

/** How many turns' calls are kept at most, for turns that never sent their end. */
const REMEMBERED_TRACES = 256;

/**
 * The calls that can make an output, per trace, from when a stretch stores
 * them until their turn ends: a result arrives in a later stretch than its
 * call, and is matched here without reading the trace back.
 */
export class OutputCalls {
  private byTrace = new Map<string, Map<string, ToolUseBlock>>();

  /** Remembers stretch `blocks`' output calls of trace `messageId`, and forgets them at its end. */
  remember(messageId: string, blocks: readonly unknown[]): void {
    for (const block of blocks) {
      if (isOutputCall(block)) {
        let calls = this.byTrace.get(messageId);
        if (!calls) {
          calls = new Map();
          this.byTrace.set(messageId, calls);
          if (this.byTrace.size > REMEMBERED_TRACES) {
            const oldest = this.byTrace.keys().next().value;
            if (oldest !== undefined) this.byTrace.delete(oldest);
          }
        }
        calls.set(block.id, block);
      }
    }
  }

  find(messageId: string, toolUseId: string): ToolUseBlock | null {
    return this.byTrace.get(messageId)?.get(toolUseId) ?? null;
  }

  /** Forgets trace `messageId`'s calls once its turn has ended. */
  endIfDone(messageId: string, blocks: readonly unknown[]): void {
    if (blocks.some((block) => (block as { type?: unknown } | null)?.type === "turn_end")) {
      this.byTrace.delete(messageId);
    }
  }
}

/**
 * The call `toolUseId` of trace `messageId` from its stored blocks, newest
 * first. Only a call no memory holds reads it, as after a restart mid-turn.
 */
function storedToolUse(db: Writer, messageId: string, toolUseId: string): ToolUseBlock | null {
  const row = db
    .select({ content: romeAgentTraceBlocks.content })
    .from(romeAgentTraceBlocks)
    .where(
      and(
        eq(romeAgentTraceBlocks.messageId, messageId),
        sql`json_extract(${romeAgentTraceBlocks.content}, '$.id') = ${toolUseId}`,
      ),
    )
    .orderBy(desc(romeAgentTraceBlocks.seq))
    .get();
  if (!row) return null;
  try {
    return JSON.parse(row.content) as ToolUseBlock;
  } catch {
    return null;
  }
}

/**
 * Records the outputs a stretch of trace `messageId` made, in the transaction
 * that stores the stretch, so an output is recorded exactly when its trace is.
 * A result's call comes from the stretch itself or from `calls`, which earlier
 * stretches filled.
 */
export function recordTraceOutputs(
  tx: DrizzleTx,
  calls: OutputCalls,
  place: OutputPlace & { messageId: string },
  blocks: readonly unknown[],
  at: Date,
): void {
  // An output that cannot be recorded never costs the trace it came with.
  try {
    calls.remember(place.messageId, blocks);
    if (mayHoldOutputs(blocks)) {
      const found = outputsInTrace(
        blocks,
        (id) => calls.find(place.messageId, id) ?? storedToolUse(tx, place.messageId, id),
        { ...localFiles(), traceId: place.messageId },
      );
      insertOutputs(tx, place, found, at);
    }
    calls.endIfDone(place.messageId, blocks);
  } catch (error) {
    log.warn("could not record a turn's outputs", {
      sessionId: place.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
   * The subagent sessions under chats `sessionIds`, at any depth, each with
   * the chat it works for: their agent's helpers, whose work is that chat's.
   * One query per level of depth, whatever the number of chats.
   */
  async subagentRoots(sessionIds: readonly string[]): Promise<Map<string, string>> {
    const roots = new Map<string, string>();
    const rootOf = new Map(sessionIds.map((id) => [id, id]));
    let parents = [...sessionIds];
    while (parents.length > 0) {
      const rows = await this.db
        .select({ id: romeSessions.id, parent: romeSessions.parentSessionId })
        .from(romeSessions)
        .where(
          and(inArray(romeSessions.parentSessionId, parents), eq(romeSessions.type, "subagent")),
        );
      parents = [];
      for (const row of rows) {
        const root = row.parent ? rootOf.get(row.parent) : undefined;
        if (!root || rootOf.has(row.id)) continue;
        rootOf.set(row.id, root);
        roots.set(row.id, root);
        parents.push(row.id);
      }
    }
    return roots;
  }

  async get(id: string): Promise<ChatOutputRow | null> {
    return (await this.db.select().from(chatOutputs).where(eq(chatOutputs.id, id)))[0] ?? null;
  }

  /**
   * When Rome began recording outputs as they happen, kept once: the first
   * call stores `now`, every later one answers what it stored. Only a chat
   * made before then has earlier outputs to read back.
   */
  recordingSince(now = new Date()): Date {
    this.db
      .insert(settings)
      .values({ key: RECORDING_SINCE_KEY, value: now.toISOString(), updatedAt: now })
      .onConflictDoNothing({ target: settings.key })
      .run();
    const row = this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, RECORDING_SINCE_KEY))
      .get();
    const stored = typeof row?.value === "string" ? new Date(row.value) : now;
    return Number.isNaN(stored.getTime()) ? now : stored;
  }

  /**
   * Which of chats `sessionIds` still need reading back, in two queries: not
   * read back yet, and made before outputs were recorded as they happen
   * (`since`). A chat made later has every output recorded already.
   */
  needingBackfill(sessionIds: readonly string[], since: Date): string[] {
    const waiting = this.notBackfilled(sessionIds);
    if (waiting.length === 0) return [];
    const older = new Set(
      this.db
        .select({ id: romeSessions.id })
        .from(romeSessions)
        .where(and(inArray(romeSessions.id, waiting), lt(romeSessions.createdAt, since)))
        .all()
        .map((row) => row.id),
    );
    return waiting.filter((id) => older.has(id));
  }

  /** Which of chats `sessionIds` have not been read back yet, in one query. */
  notBackfilled(sessionIds: readonly string[]): string[] {
    if (sessionIds.length === 0) return [];
    const done = new Set(
      this.db
        .select({ id: chatOutputBackfills.sessionId })
        .from(chatOutputBackfills)
        .where(inArray(chatOutputBackfills.sessionId, [...sessionIds]))
        .all()
        .map((row) => row.id),
    );
    return sessionIds.filter((id) => !done.has(id));
  }

  /**
   * Reads back what chat `sessionId` made before outputs were recorded, from
   * its `messages`: the write, shell and show calls its stored traces still
   * hold, the local files its replies link, and the asset links its agent's
   * messages hold that no guardian message attached. An output already recorded is not recorded again, so a second
   * read back changes nothing. A trace stored whole on its message row, from
   * before traces were stored block by block, is not read back.
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
          const found = this.traceOutputs(tx, message.id);
          insertOutputs(tx, place, found, message.createdAt);
        }
      }
      tx.insert(chatOutputBackfills)
        .values({ sessionId, backfilledAt: now })
        .onConflictDoNothing()
        .run();
    });
  }

  /** A stored trace's outputs, from its block rows. */
  private traceOutputs(tx: DrizzleTx, messageId: string): OutputFound[] {
    const rows = tx
      .select({ content: romeAgentTraceBlocks.content })
      .from(romeAgentTraceBlocks)
      .where(
        and(
          eq(romeAgentTraceBlocks.messageId, messageId),
          sql`json_extract(${romeAgentTraceBlocks.content}, '$.type') IN ('tool_use', 'tool_result', 'result')`,
        ),
      )
      .orderBy(asc(romeAgentTraceBlocks.seq))
      .all();
    const blocks: unknown[] = [];
    for (const row of rows) {
      try {
        blocks.push(JSON.parse(row.content));
      } catch {
        // A block that does not parse made no output.
      }
    }
    return outputsInTrace(blocks, undefined, { ...localFiles(), traceId: messageId });
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
