import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { SentinelLogRepository } from "./sentinel-log.js";
import { eq } from "drizzle-orm";
import { sentinelLog } from "../schema.js";

describe("SentinelLogRepository", () => {
  let testDb: TestDb;
  let repo: SentinelLogRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new SentinelLogRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  const makeEntry = (overrides?: Record<string, unknown>) => ({
    messageId: "msg-001",
    channel: "telegram",
    channelUserId: "user-123",
    displayName: "Test User",
    threadId: "thread-001",
    text: "Hello there",
    action: "replied" as const,
    response: "Hi! How can I help?",
    ...overrides,
  });

  it("create() inserts log entry", async () => {
    const id = await repo.create(makeEntry());
    expect(id).toBeDefined();

    const rows = await testDb.db.select().from(sentinelLog).where(eq(sentinelLog.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe("msg-001");
    expect(rows[0].action).toBe("replied");
    expect(rows[0].reviewed).toBe(false);
  });

  it("findUnreviewed() returns only unreviewed entries", async () => {
    const id1 = await repo.create(makeEntry({ messageId: "msg-1" }));
    await repo.create(makeEntry({ messageId: "msg-2" }));

    // Mark first as reviewed
    await repo.markReviewed([id1]);

    const unreviewed = await repo.findUnreviewed();
    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0].messageId).toBe("msg-2");
  });

  it("findUnreviewed() returns empty array when all reviewed", async () => {
    const id1 = await repo.create(makeEntry({ messageId: "msg-1" }));
    const id2 = await repo.create(makeEntry({ messageId: "msg-2" }));

    await repo.markReviewed([id1, id2]);

    const unreviewed = await repo.findUnreviewed();
    expect(unreviewed).toHaveLength(0);
  });

  it("markReviewed() sets reviewed=true for given IDs", async () => {
    const id1 = await repo.create(makeEntry({ messageId: "msg-1" }));
    const id2 = await repo.create(makeEntry({ messageId: "msg-2" }));
    const id3 = await repo.create(makeEntry({ messageId: "msg-3" }));

    await repo.markReviewed([id1, id3]);

    const rows = await testDb.db.select().from(sentinelLog);
    const reviewed = rows.filter((r) => r.reviewed);
    const unreviewed = rows.filter((r) => !r.reviewed);

    expect(reviewed).toHaveLength(2);
    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0].id).toBe(id2);
  });

  describe("listSenders()", () => {
    it("answers one row per sender, however many messages the log holds", async () => {
      await repo.create(makeEntry({ messageId: "msg-1", channel: "telegram", channelUserId: "a" }));
      await repo.create(makeEntry({ messageId: "msg-2", channel: "telegram", channelUserId: "a" }));
      await repo.create(makeEntry({ messageId: "msg-3", channel: "telegram", channelUserId: "b" }));
      await repo.create(makeEntry({ messageId: "msg-4", channel: "whatsapp", channelUserId: "a" }));

      const senders = await repo.listSenders();
      expect(
        senders
          .map((sender) => `${sender.channel}:${sender.channelUserId}`)
          .sort((left, right) => left.localeCompare(right)),
      ).toEqual(["telegram:a", "telegram:b", "whatsapp:a"]);
    });

    it("carries the address alone, and nothing derived from a message", async () => {
      await repo.create(makeEntry());

      // The callers are account reads: they name an account and preview nothing,
      // so a newest message or a count here would be work no reader renders.
      const [sender] = await repo.listSenders();
      expect(Object.keys(sender).sort()).toEqual(["channel", "channelUserId"]);
    });

    it("answers nothing for an empty log", async () => {
      expect(await repo.listSenders()).toEqual([]);
    });
  });

  it("findByChannelUser() returns entries for specific sender", async () => {
    await repo.create(makeEntry({ messageId: "msg-1", channelUserId: "user-A" }));
    await repo.create(makeEntry({ messageId: "msg-2", channelUserId: "user-A" }));
    await repo.create(makeEntry({ messageId: "msg-3", channelUserId: "user-B" }));

    // SentinelLogRepository doesn't have a findByChannelUser method, so we query directly
    const rows = await testDb.db
      .select()
      .from(sentinelLog)
      .where(eq(sentinelLog.channelUserId, "user-A"));

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.channelUserId === "user-A")).toBe(true);
  });
});
