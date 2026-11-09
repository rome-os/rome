import { and, eq, lt, notInArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { executionJournal } from "../schema.js";
import type { DrizzleDb } from "../index.js";
import type { JournalEntry } from "../../apps/actions/replay.js";

export class ExecutionJournalRepository {
  constructor(private db: DrizzleDb) {}

  async saveJournal(rootExecutionId: string, entries: JournalEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const now = new Date();
    await this.db.insert(executionJournal).values(
      entries.map((entry) => ({
        id: uuid(),
        rootExecutionId,
        sequence: entry.sequence,
        actionName: entry.actionName,
        argsHash: entry.argsHash,
        args: entry.args,
        result: entry.result,
        status: entry.status,
        expectedActionName: entry.expectedActionName ?? null,
        expectedArgsHash: entry.expectedArgsHash ?? null,
        actualActionName: entry.actualActionName ?? null,
        actualArgsHash: entry.actualArgsHash ?? null,
        createdAt: now,
      })),
    );
  }

  async loadJournal(rootExecutionId: string): Promise<JournalEntry[]> {
    const rows = await this.db
      .select()
      .from(executionJournal)
      .where(eq(executionJournal.rootExecutionId, rootExecutionId));
    return rows
      .sort((a, b) => a.sequence - b.sequence)
      .map((row) => ({
        sequence: row.sequence,
        actionName: row.actionName,
        argsHash: row.argsHash,
        args: (row.args ?? {}) as Record<string, unknown>,
        result: row.result as JournalEntry["result"],
        status: row.status as JournalEntry["status"],
        expectedActionName: row.expectedActionName ?? undefined,
        expectedArgsHash: row.expectedArgsHash ?? undefined,
        actualActionName: row.actualActionName ?? undefined,
        actualArgsHash: row.actualArgsHash ?? undefined,
      }));
  }

  async updateEntry(
    rootExecutionId: string,
    sequence: number,
    result: unknown,
    status: string,
  ): Promise<void> {
    await this.db
      .update(executionJournal)
      .set({ result: result as Record<string, unknown>, status })
      .where(
        and(
          eq(executionJournal.rootExecutionId, rootExecutionId),
          eq(executionJournal.sequence, sequence),
        ),
      );
  }

  async deleteJournal(rootExecutionId: string): Promise<void> {
    await this.db
      .delete(executionJournal)
      .where(eq(executionJournal.rootExecutionId, rootExecutionId));
  }

  async deleteOlderThan(cutoff: Date, excludeRootIds?: string[]): Promise<void> {
    const conditions = [lt(executionJournal.createdAt, cutoff)];
    if (excludeRootIds && excludeRootIds.length > 0) {
      conditions.push(notInArray(executionJournal.rootExecutionId, excludeRootIds));
    }
    await this.db.delete(executionJournal).where(and(...conditions));
  }
}
