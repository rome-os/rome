import { eq } from "drizzle-orm";
import { settings } from "../schema.js";
import type { DrizzleDb, DrizzleTx, SqliteExec } from "../index.js";

export class SettingsRepository {
  constructor(private db: DrizzleDb) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const rows = await this.db.select().from(settings).where(eq(settings.key, key));
    if (rows.length === 0) return null;
    return rows[0].value as T;
  }

  // One atomic upsert rather than a read-then-branch: two concurrent writers to
  // the same key would both observe an empty read and race into a duplicate
  // insert on the `settings.key` primary key.
  async set(key: string, value: unknown): Promise<void> {
    this.write(this.db, key, value);
  }

  /** {@link get}, read through a caller's transaction. */
  read<T = unknown>(exec: DrizzleDb | DrizzleTx, key: string): T | null {
    const row = exec.select().from(settings).where(eq(settings.key, key)).get();
    return row ? (row.value as T) : null;
  }

  /** Write helper for {@link set}, taking an executor so it runs standalone
   *  (`this.db`) or enlisted in a caller's transaction. */
  write(exec: SqliteExec, key: string, value: unknown): void {
    const now = new Date();
    exec
      .insert(settings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: now },
      })
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.db.select().from(settings);
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }
}

export function createSettingsRepository(db: DrizzleDb) {
  return new SettingsRepository(db);
}
