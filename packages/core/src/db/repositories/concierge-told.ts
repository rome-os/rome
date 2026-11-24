import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { DrizzleDb } from "../index.js";
import { conciergeTold } from "../schema.js";

export type ToldKind = (typeof conciergeTold.$inferSelect)["kind"];

/** One thing a told turn was about. */
export interface ToldItem {
  /** The topic, such as `follow:<source>:<target>` or an observation's topic key. */
  topic: string;
  line: string;
}

export interface ToldEntry {
  id: string;
  ownerKey: string;
  kind: ToldKind;
  chatId: string;
  messages: number;
  items: ToldItem[];
  toldAt: Date;
}

/** Items one entry keeps; a digest with more keeps its first ones. */
export const MAX_TOLD_ITEMS = 40;
const MAX_LINE_CHARS = 200;

const itemsOf = (raw: string): ToldItem[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const { topic, line } = (item ?? {}) as { topic?: unknown; line?: unknown };
      return typeof topic === "string" && typeof line === "string" ? [{ topic, line }] : [];
    });
  } catch {
    return [];
  }
};

const toEntry = (row: typeof conciergeTold.$inferSelect): ToldEntry => ({
  ...row,
  items: itemsOf(row.items),
});

/**
 * The shared "already told" ledger: what the Concierge told its owner on its
 * own, written by alerts, digests and the patrol. Only a turn that said
 * something is recorded.
 */
export class ConciergeToldRepository {
  constructor(private db: DrizzleDb) {}

  /** Records a told turn. A turn that said nothing is not recorded, and answers null. */
  async record(entry: {
    ownerKey?: string;
    kind: ToldKind;
    chatId: string;
    messages: number;
    items: readonly ToldItem[];
    at: Date;
  }): Promise<ToldEntry | null> {
    if (entry.messages < 1) return null;
    const items = entry.items.slice(0, MAX_TOLD_ITEMS).map((item) => ({
      topic: item.topic,
      line:
        item.line.length > MAX_LINE_CHARS
          ? `${item.line.slice(0, MAX_LINE_CHARS - 1)}…`
          : item.line,
    }));
    const [row] = await this.db
      .insert(conciergeTold)
      .values({
        id: randomUUID(),
        ownerKey: entry.ownerKey ?? "guardian",
        kind: entry.kind,
        chatId: entry.chatId,
        messages: entry.messages,
        items: JSON.stringify(items),
        toldAt: entry.at,
      })
      .returning();
    return row ? toEntry(row) : null;
  }

  /** What `owner` was told since `since`, newest first. */
  async since(since: Date, owner = "guardian"): Promise<ToldEntry[]> {
    const rows = await this.db
      .select()
      .from(conciergeTold)
      .where(and(eq(conciergeTold.ownerKey, owner), gte(conciergeTold.toldAt, since)))
      .orderBy(desc(conciergeTold.toldAt));
    return rows.map(toEntry);
  }

  /** How many messages `owner` was told on the Concierge's own since `since`, of every kind. */
  async messagesSince(since: Date, owner = "guardian"): Promise<number> {
    return (await this.since(since, owner)).reduce((sum, entry) => sum + entry.messages, 0);
  }

  /** Deletes entries older than `before`. */
  async prune(before: Date): Promise<void> {
    await this.db.delete(conciergeTold).where(lt(conciergeTold.toldAt, before));
  }
}
