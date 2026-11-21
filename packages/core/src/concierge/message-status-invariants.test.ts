import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { ConciergeTasks } from "./tasks.js";

// Random runs of the events a message's status follows, in any order, that
// check one rule throughout (docs/domains/chats.md#status): a settled message
// stays as it settled. A message is settled once its turn answered it and no
// task follows it; nothing that happens later, a task's ending, a failure or
// a newer message taking a task over, changes how it shows.

const CHAT = "concierge";
const TASKS = ["t0", "t1", "t2"];

/** A small seeded random source, so a failing run can be replayed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("message status invariants", () => {
  let db: TestDb;
  let repo: ConciergeTasksRepository;
  let tasks: ConciergeTasks;
  const running = new Set<string>();

  beforeEach(async () => {
    db = createTestDb();
    const chats = new ChatsWebChatRepository(db.db);
    await chats.createSession(CHAT, CHAT, undefined, "default", null, "default", "core:concierge");
    for (const id of TASKS) {
      await chats.createSession(
        `chat-${id}`,
        id,
        undefined,
        "default",
        null,
        "default",
        "core:main",
      );
    }
    repo = new ConciergeTasksRepository(db.db);
    tasks = new ConciergeTasks(repo);
    running.clear();
    tasks.attachFacts({
      now: () => Date.now(),
      running: (chatId) => running.has(chatId),
      openWaits: async () => new Map(),
      reportPending: () => [],
    });
  });
  afterEach(() => db.close());

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`keeps every settled message as it settled (seed ${seed})`, async () => {
      const next = random(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const rows = await Promise.all(
        TASKS.map((id) => repo.create(`chat-${id}`, { chatId: CHAT })),
      );
      const taskIds = rows.map((row) => row.id);
      const chatOf = new Map(rows.map((row) => [row.id, row.sessionId!]));
      let turn = 0;
      let made = 0;
      /** The messages the running turn took and has not answered. */
      let open: string[] = [];
      const all: string[] = [];
      const settledAs = new Map<string, string | null>();

      const statuses = async () => {
        const marks = await repo.messageMarks(CHAT, all);
        const shown = await tasks.messageStatusesOf(CHAT, all);
        return all.map((key) => {
          const mark = marks.get(key);
          const settled = mark?.answered === true && mark.taskIds.length === 0;
          return { key, settled, status: shown.get(key) ?? null };
        });
      };
      const endIfTold = async (taskId: string) => {
        const row = await repo.get(taskId);
        if (row) await tasks.endLinksIfEnded(row);
      };

      const steps: (() => Promise<void>)[] = [
        // The guardian sends a message; the running turn takes it.
        async () => {
          const key = `m${made++}`;
          all.push(key);
          open.push(key);
          await repo.takeMessage(`turn-${turn}`, { chatId: CHAT, messageKey: key });
        },
        // The turn answers one with a message.
        async () => {
          if (open.length === 0) return;
          const key = pick(open);
          open = open.filter((one) => one !== key);
          await repo.answerMessage(CHAT, key);
        },
        async () => {
          if (open.length > 0) await repo.markWorking(CHAT);
        },
        async () => {
          if (open.length > 0) await repo.markReacted(CHAT, pick(open));
        },
        // The turn starts a task for one, or sends one's words to a task.
        async () => {
          if (open.length === 0) return;
          const taskId = pick(taskIds);
          await repo.linkMessage(taskId, { chatId: CHAT, messageKey: pick(open) });
          running.add(chatOf.get(taskId)!);
        },
        // The turn ends, well or failed.
        async () => {
          await repo.answerTurns(CHAT, [], new Date(), { failed: next() < 0.4 });
          open = [];
          turn += 1;
        },
        // A task's chat runs again, or ends well or failed.
        async () => {
          running.add(chatOf.get(pick(taskIds))!);
        },
        async () => {
          const taskId = pick(taskIds);
          running.delete(chatOf.get(taskId)!);
          await repo.setLastOutcome(taskId, next() < 0.5 ? "succeeded" : "failed");
        },
        // Its result is told, or Rome gives up telling it.
        async () => {
          const taskId = pick(taskIds);
          await repo.markReported([taskId]);
          await endIfTold(taskId);
        },
        async () => {
          const taskId = pick(taskIds);
          await repo.markGivenUp(taskId);
          await endIfTold(taskId);
        },
      ];

      for (let step = 0; step < 150; step += 1) {
        await pick(steps)();
        for (const { key, settled, status } of await statuses()) {
          if (settledAs.has(key)) {
            expect({ seed, step, key, status }).toEqual({
              seed,
              step,
              key,
              status: settledAs.get(key),
            });
          } else if (settled) {
            settledAs.set(key, status);
          }
        }
      }
      // The run reached settled messages of each kind it can.
      expect(settledAs.size).toBeGreaterThan(0);
    });
  }
});
