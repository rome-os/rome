import { eq } from "drizzle-orm";
import { appKeys } from "../../db/schema.js";
import type { DrizzleDb } from "../../db/index.js";

export interface AppKeyRow {
  name: string;
  label: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The value-free projection the API returns. The secret only leaves this
 * repository through `listWithValues`, whose sole consumer is the boot/save
 * injector. */
export interface AppKeySummary {
  name: string;
  label: string;
  createdAt: Date;
  updatedAt: Date;
}

export class AppKeysRepository {
  constructor(private db: DrizzleDb) {}

  async list(): Promise<AppKeySummary[]> {
    const rows = await this.db
      .select({
        name: appKeys.name,
        label: appKeys.label,
        createdAt: appKeys.createdAt,
        updatedAt: appKeys.updatedAt,
      })
      .from(appKeys);
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listWithValues(): Promise<AppKeyRow[]> {
    return await this.db.select().from(appKeys);
  }

  async get(name: string): Promise<AppKeyRow | null> {
    const rows = await this.db.select().from(appKeys).where(eq(appKeys.name, name));
    return rows[0] ?? null;
  }

  // One atomic upsert rather than a read-then-branch: two concurrent writers to
  // the same name would both observe an empty read and race into a duplicate
  // insert on the `app_keys.name` primary key.
  async upsert(input: { name: string; label: string; value: string }): Promise<void> {
    const now = new Date();
    await this.db
      .insert(appKeys)
      .values({ ...input, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: appKeys.name,
        set: { label: input.label, value: input.value, updatedAt: now },
      });
  }

  async delete(name: string): Promise<void> {
    await this.db.delete(appKeys).where(eq(appKeys.name, name));
  }
}
