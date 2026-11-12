import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/db.js";
import { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { ConciergeTasks } from "./tasks.js";
import { NO_RESPONSE_REASON, WaitExpiry } from "./wait-expiry.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 12, 9);

describe("WaitExpiry", () => {
  let testDb: TestDb;
  let repo: ConciergeTasksRepository;
  let tasks: ConciergeTasks;
  let now: number;
  let waiting: Map<string, number>;
  let told: string[];
  let expired: [string, number, string, boolean][];
  let expiry: WaitExpiry;

  beforeEach(async () => {
    testDb = createTestDb();
    repo = new ConciergeTasksRepository(testDb.db);
    tasks = new ConciergeTasks(repo, 24 * HOUR);
    now = NOW;
    waiting = new Map();
    tasks.attachFacts({
      now: () => now,
      running: () => false,
      waitingSince: async (chatIds) =>
        new Map(chatIds.flatMap((id) => (waiting.has(id) ? [[id, waiting.get(id)!]] : []))),
      reportPending: () => [],
    });
    told = [];
    expired = [];
    expiry = new WaitExpiry({
      tasks,
      expireApprovals: async (chatId, turnDown) => (
        expired.push([chatId, turnDown.until, turnDown.reason, turnDown.continueTurn]), 1
      ),
      tell: (taskId) => told.push(taskId),
      now: () => now,
    });
    await new ChatsWebChatRepository(testDb.db).createSession("task-chat", "Flights");
  });
  afterEach(() => testDb.close());

  it("ends a task its owner did not answer within the wait, once, and turns its approvals down", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    waiting.set("task-chat", NOW - 2 * HOUR);
    await expiry.expire(row!.id);
    // Not due yet: nothing happens.
    expect(told).toEqual([]);

    now = NOW + 23 * HOUR;
    await expiry.expire(row!.id);
    expect(told).toEqual([row!.id]);
    expect(expired).toEqual([["task-chat", NOW + 22 * HOUR, NO_RESPONSE_REASON, true]]);
    expect((await tasks.statusOf([(await repo.get(row!.id))!])).get(row!.id)).toMatchObject({
      status: "ended",
      endReason: "no_response",
    });
    // One wait ends once, also after a restart.
    await expiry.expire(row!.id);
    expect(told).toEqual([row!.id]);
    // A new wait ends again.
    waiting.set("task-chat", now);
    now += 25 * HOUR;
    await expiry.expire(row!.id);
    expect(told).toEqual([row!.id, row!.id]);
  });

  it("handles an expiry once when two calls for one task overlap", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    waiting.set("task-chat", NOW - 25 * HOUR);
    await Promise.all([expiry.expire(row!.id), expiry.expire(row!.id)]);
    expect(expired).toHaveLength(1);
    expect(told).toEqual([row!.id]);
  });

  it("never ends a stopped or archived task's wait for no response", async () => {
    const [stopped, archived] = await repo.upsertMany([
      { title: "Stopped", sessionId: "task-chat" },
      { title: "Archived" },
    ]);
    await repo.stop(stopped!.id, "guardian");
    await repo.upsertMany([{ id: archived!.id, archived: true }]);
    waiting.set("task-chat", NOW - 30 * HOUR);
    await expiry.expire(stopped!.id);
    await expiry.expire(archived!.id);
    expect(told).toEqual([]);
    expect(expired).toEqual([]);
  });

  it("turns approvals down before it marks the wait handled, so a failed turn-down is tried again", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    waiting.set("task-chat", NOW - 30 * HOUR);
    let fail = true;
    const flaky = new WaitExpiry({
      tasks,
      expireApprovals: async () => {
        if (fail) throw new Error("database is locked");
        return 1;
      },
      tell: (taskId) => told.push(taskId),
      now: () => now,
    });
    await expect(flaky.expire(row!.id)).rejects.toThrow("database is locked");
    expect((await repo.get(row!.id))?.expiredWaitAt).toBeNull();
    fail = false;
    await flaky.expire(row!.id);
    expect(told).toEqual([row!.id]);
  });

  it("handles a wait that expired while Rome was down when it starts", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    waiting.set("task-chat", NOW - 30 * HOUR);
    const stop = expiry.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(told).toEqual([row!.id]);
    stop();
  });

  it("stops reading a task once its wait is handled, though its card stays open", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    waiting.set("task-chat", NOW - 30 * HOUR);
    const reads = rs.spyOn(repo, "get");
    const stop = expiry.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(told).toEqual([row!.id]);
    const afterExpiry = reads.mock.calls.length;
    // The open card is read again, as any read of the task does; no timer follows.
    await tasks.statusOf([(await repo.get(row!.id))!]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads.mock.calls.length).toBe(afterExpiry + 1);
    stop();
  });

  it("keeps a task whose approval Rome turned down ended for no response, through the turn that carries on", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    waiting.set("task-chat", NOW - 30 * HOUR);
    await expiry.expire(row!.id);
    // The approval is turned down, so nothing waits; the turn that carries on
    // ends, even failed, and its report is said.
    waiting.delete("task-chat");
    await repo.setLastOutcome(row!.id, "failed", new Date(), { reported: false });
    const status = async () => (await tasks.statusOf([(await repo.get(row!.id))!])).get(row!.id);
    expect(await status()).toMatchObject({ status: "ended", endReason: "no_response" });
    // Someone wrote to it after: it ends as that work does.
    await repo.clearWaitExpired(row!.id);
    await repo.setLastOutcome(row!.id, "succeeded", new Date(), { reported: false });
    expect(await status()).toMatchObject({ status: "ended", endReason: "done" });
  });

  it("lists a task that ended for no response in the next digest, once", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    waiting.set("task-chat", NOW - 30 * HOUR);
    await expiry.expire(row!.id);
    expect(await repo.noResponseUnlisted([row!.id])).toEqual([row!.id]);
    // Still unlisted until a digest that lists it runs to its end.
    expect(await repo.noResponseUnlisted([row!.id])).toEqual([row!.id]);
    await repo.markNoResponseListed([row!.id]);
    expect(await repo.noResponseUnlisted([row!.id])).toEqual([]);
  });
});
