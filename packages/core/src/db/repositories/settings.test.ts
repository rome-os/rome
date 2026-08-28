import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import type { DrizzleDb } from "../index.js";
import { settings } from "../schema.js";
import { SettingsRepository } from "./settings.js";

// Records which statement builders (`select`, `insert`, `update`, `delete`) a
// repository reaches for, so a test can assert `set` writes without reading.
function trackStatements(db: DrizzleDb): { db: DrizzleDb; statements: string[] } {
  const statements: string[] = [];
  const tracked = new Proxy(db as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (prop === "select" || prop === "insert" || prop === "update" || prop === "delete") {
        statements.push(prop);
      }
      return value.bind(target);
    },
  }) as DrizzleDb;
  return { db: tracked, statements };
}

describe("SettingsRepository", () => {
  let testDb: TestDb;
  let repo: SettingsRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new SettingsRepository(testDb.db);
  });

  afterEach(() => {
    rs.useRealTimers();
    testDb.close();
  });

  it("get() returns parsed JSON value for key", async () => {
    await repo.set("greeting", "Hello, world!");
    const value = await repo.get<string>("greeting");
    expect(value).toBe("Hello, world!");
  });

  it("get() returns null for missing key", async () => {
    const value = await repo.get("nonexistent");
    expect(value).toBeNull();
  });

  it("set() inserts new key-value pair", async () => {
    await repo.set("theme", { mode: "dark", fontSize: 14 });
    const value = await repo.get<{ mode: string; fontSize: number }>("theme");
    expect(value).toEqual({ mode: "dark", fontSize: 14 });
  });

  it("set() updates existing key-value pair", async () => {
    await repo.set("counter", 1);
    await repo.set("counter", 2);
    const value = await repo.get<number>("counter");
    expect(value).toBe(2);
  });

  describe("set() upsert", () => {
    it("issues a single write statement with no read before it", async () => {
      const { db, statements } = trackStatements(testDb.db);
      const trackedRepo = new SettingsRepository(db);

      await trackedRepo.set("tracked", "value");

      expect(statements).toEqual(["insert"]);
    });

    it("issues a single write statement when the key already exists", async () => {
      await repo.set("tracked", "first");
      const { db, statements } = trackStatements(testDb.db);
      const trackedRepo = new SettingsRepository(db);

      await trackedRepo.set("tracked", "second");

      expect(statements).toEqual(["insert"]);
      expect(await repo.get<string>("tracked")).toBe("second");
    });

    it("creates the row when the key is absent", async () => {
      const before = await testDb.db.select().from(settings).where(eq(settings.key, "fresh"));
      expect(before).toHaveLength(0);

      await repo.set("fresh", { created: true });

      const rows = await testDb.db.select().from(settings).where(eq(settings.key, "fresh"));
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toEqual({ created: true });
    });

    it("replaces the value and advances updated_at when the key is present", async () => {
      rs.useFakeTimers({ toFake: ["Date"] });
      rs.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      await repo.set("stamped", "first");
      const [first] = await testDb.db.select().from(settings).where(eq(settings.key, "stamped"));

      rs.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
      await repo.set("stamped", "second");
      const rows = await testDb.db.select().from(settings).where(eq(settings.key, "stamped"));

      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe("second");
      expect(rows[0].updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
    });

    it("survives two concurrent writes to the same key", async () => {
      await expect(
        Promise.all([repo.set("concurrent", "a"), repo.set("concurrent", "b")]),
      ).resolves.toBeDefined();

      const rows = await testDb.db.select().from(settings).where(eq(settings.key, "concurrent"));
      expect(rows).toHaveLength(1);
      expect(["a", "b"]).toContain(rows[0].value);
    });
  });

  it("getAll() returns all settings as object", async () => {
    await repo.set("key1", "value1");
    await repo.set("key2", { nested: true });
    await repo.set("key3", 42);

    const all = await repo.getAll();
    expect(all).toEqual({
      key1: "value1",
      key2: { nested: true },
      key3: 42,
    });
  });
});
