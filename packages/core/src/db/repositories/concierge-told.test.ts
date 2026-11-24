import { afterEach, describe, expect, it } from "@rstest/core";
import { createTestDb } from "../../test/db.js";
import { ConciergeObservationsRepository } from "./concierge-observations.js";
import { ConciergeToldRepository, MAX_TOLD_ITEMS } from "./concierge-told.js";

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
const db = () => {
  const testDb = createTestDb();
  opened.push(testDb);
  return testDb.db;
};
const at = (hours: number) => new Date(Date.UTC(2026, 10, 23, hours));

describe("the already-told ledger", () => {
  it("records only a turn that said something, and counts messages across kinds", async () => {
    const told = new ConciergeToldRepository(db());
    expect(
      await told.record({ kind: "alert", chatId: "c", messages: 0, items: [], at: at(1) }),
    ).toBeNull();
    await told.record({ kind: "alert", chatId: "c", messages: 1, items: [], at: at(2) });
    await told.record({ kind: "digest", chatId: "c", messages: 2, items: [], at: at(3) });
    await told.record({ kind: "patrol", chatId: "c", messages: 1, items: [], at: at(4) });
    expect(await told.messagesSince(at(0))).toBe(4);
    expect(await told.messagesSince(at(3))).toBe(3);
    expect((await told.since(at(0))).map((e) => e.kind)).toEqual(["patrol", "digest", "alert"]);
  });

  it("keeps each owner's apart, bounds the items it keeps, and prunes old entries", async () => {
    const told = new ConciergeToldRepository(db());
    const items = Array.from({ length: MAX_TOLD_ITEMS + 5 }, (_, i) => ({
      topic: `t${i}`,
      line: "x".repeat(300),
    }));
    await told.record({ kind: "digest", chatId: "c", messages: 1, items, at: at(1) });
    await told.record({
      ownerKey: "visitor:a",
      kind: "alert",
      chatId: "v",
      messages: 1,
      items: [],
      at: at(1),
    });
    const [entry] = await told.since(at(0));
    expect(entry?.items).toHaveLength(MAX_TOLD_ITEMS);
    expect(entry?.items[0]?.line.length).toBe(200);
    expect(await told.messagesSince(at(0), "visitor:a")).toBe(1);
    await told.prune(at(2));
    expect(await told.since(at(0))).toEqual([]);
  });
});

describe("the patrol's observations", () => {
  const write = {
    topicKey: "task:t1:waiting",
    kind: "state_change" as const,
    source: "tasks" as const,
    basis: "observed" as const,
    confidence: 0.8,
    status: "open" as const,
    summary: "A task waits",
    taskId: "t1",
    dueAt: null,
    expiresAt: at(30),
  };

  it("keeps one per topic, and a rewrite keeps its outcome history", async () => {
    const observations = new ConciergeObservationsRepository(db());
    await observations.upsert(write, at(1));
    await observations.recordOutcome(write.topicKey, { outcome: "told", at: at(2).getTime() });
    await observations.recordOutcome(write.topicKey, { outcome: "ignored", at: at(9).getTime() });
    await observations.upsert({ ...write, summary: "Still waits", confidence: 0.9 }, at(10));
    const [one, ...rest] = await observations.list();
    expect(rest).toEqual([]);
    expect(one).toMatchObject({
      summary: "Still waits",
      toldCount: 1,
      ignoredCount: 1,
      lastToldAt: at(2),
    });
    expect(one?.outcomes.map((o) => o.outcome)).toEqual(["told", "ignored"]);
  });

  it("expires what passed its expiry, and prunes what ended long ago", async () => {
    const observations = new ConciergeObservationsRepository(db());
    await observations.upsert({ ...write, expiresAt: at(5) }, at(1));
    expect(await observations.expire(at(6))).toBe(1);
    expect((await observations.list())[0]?.status).toBe("expired");
    await observations.prune(at(7));
    expect(await observations.list()).toEqual([]);
  });
});
