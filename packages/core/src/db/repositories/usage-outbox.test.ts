import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import type { ActionRunUsageEvent } from "../../usage/events.js";
import { UsageOutboxRepository } from "./usage-outbox.js";

function run(eventId: string, status: ActionRunUsageEvent["status"] = "success") {
  return {
    type: "action_run",
    eventId,
    kind: "routine",
    appId: null,
    status,
    durationMs: 10,
    occurredAt: "2026-10-06T12:00:00.000Z",
  } satisfies ActionRunUsageEvent;
}

describe("UsageOutboxRepository", () => {
  let testDb: TestDb;
  let repo: UsageOutboxRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new UsageOutboxRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it("keeps the first event queued for a type and id", async () => {
    await repo.enqueue(run("a", "success"));
    await repo.enqueue(run("a", "error"));
    await repo.enqueue(run("b"));
    const queued = await repo.peek(10);
    expect(queued.map((entry) => [entry.event.eventId, entry.event.status])).toEqual([
      ["a", "success"],
      ["b", "success"],
    ]);
  });

  it("peeks in enqueue order without removing, then removes by seq", async () => {
    for (const id of ["a", "b", "c"]) await repo.enqueue(run(id));
    const firstTwo = await repo.peek(2);
    expect(firstTwo.map((entry) => entry.event.eventId)).toEqual(["a", "b"]);
    expect(await repo.peek(10)).toHaveLength(3);
    await repo.remove(firstTwo.map((entry) => entry.seq));
    expect((await repo.peek(10)).map((entry) => entry.event.eventId)).toEqual(["c"]);
  });

  it("prunes events queued before the cutoff", async () => {
    await repo.enqueue(run("old"), new Date("2026-09-01T00:00:00Z"));
    await repo.enqueue(run("new"), new Date("2026-10-06T00:00:00Z"));
    expect(await repo.pruneBefore(new Date("2026-10-01T00:00:00Z"))).toBe(1);
    expect((await repo.peek(10)).map((entry) => entry.event.eventId)).toEqual(["new"]);
  });
});
