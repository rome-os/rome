import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
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
  let expired: [string, number, string][];
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
      expireApprovals: async (chatId, until, reason) => (expired.push([chatId, until, reason]), 1),
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
    expect(expired).toEqual([["task-chat", NOW + 22 * HOUR, NO_RESPONSE_REASON]]);
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

  it("handles a wait that expired while Rome was down when it starts", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    waiting.set("task-chat", NOW - 30 * HOUR);
    const stop = expiry.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(told).toEqual([row!.id]);
    stop();
  });

  it("lists a task that ended for no response in the next digest, once", async () => {
    const [row] = await repo.upsertMany([{ title: "Flights", sessionId: "task-chat" }]);
    waiting.set("task-chat", NOW - 30 * HOUR);
    await expiry.expire(row!.id);
    expect(await repo.takeNoResponseUnlisted([row!.id])).toEqual([row!.id]);
    expect(await repo.takeNoResponseUnlisted([row!.id])).toEqual([]);
  });
});
