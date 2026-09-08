import { eq } from "drizzle-orm";
import type { AppDbContext, DrizzleDb } from "@rome-os/app-runtime";
import { CONFIG_KEY, type ManagerConfig, parseConfig } from "../../lib/config.js";
import { createAppDbSchema } from "../schema.js";

/** The one config row `manager:setup` writes and every other action reads. */
export class SettingsRepository {
  private readonly tables;

  constructor(
    private readonly db: DrizzleDb,
    tablePrefix: string,
  ) {
    this.tables = createAppDbSchema(tablePrefix);
  }

  get(): ManagerConfig | undefined {
    const row = this.db
      .select()
      .from(this.tables.config)
      .where(eq(this.tables.config.key, CONFIG_KEY))
      .get();
    if (!row) return undefined;
    const parsed = parseConfig(JSON.parse(row.value));
    return parsed.ok ? parsed.config : undefined;
  }

  put(config: ManagerConfig): void {
    this.db
      .insert(this.tables.config)
      .values({ key: CONFIG_KEY, value: JSON.stringify(config), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: this.tables.config.key,
        set: { value: JSON.stringify(config), updatedAt: new Date() },
      })
      .run();
  }
}

export function createSettingsRepository(ctx: AppDbContext): SettingsRepository {
  return new SettingsRepository(ctx.connection, ctx.tablePrefix);
}
