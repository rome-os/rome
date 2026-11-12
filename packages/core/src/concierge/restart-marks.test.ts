import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { TASK_CHAT_TRIGGER_KIND } from "../webchat/privacy.js";
import { settleMarksAfterRestart } from "./restart-marks.js";

// The status reactions a killed Rome process leaves working, settled when the
// next one boots (docs/domains/chats.md#status-reaction). The state is written
// the way a running process writes it; the process then dies, so no turn ends.

const DAY = 24 * 60 * 60 * 1000;

describe("status reactions after a restart", () => {
  let db: TestDb;
  let chats: ChatsWebChatRepository;
  let tasks: ConciergeTasksRepository;

  beforeEach(() => {
    db = createTestDb();
    chats = new ChatsWebChatRepository(db.db);
    tasks = new ConciergeTasksRepository(db.db);
  });
  afterEach(() => db.close());

  /** Chat `id` with a turn running the guardian's message `${id}-input` when the process died. */
  async function running(id: string, agent = "core:concierge", triggerKind?: string) {
    await chats.createSession(id, id, undefined, "default", null, "default", agent);
    if (triggerKind) await chats.setSessionTrigger(id, { triggerKind, triggerName: id });
    await chats.recordUserInput(
      `${id}-input`,
      id,
      JSON.stringify([{ type: "text", content: "Do it" }]),
    );
    await chats.updateUserInput(id, {
      type: "input_status",
      inputId: `${id}-input`,
      turnId: `${id}-turn`,
      state: "consumed",
    });
    await chats.appendTraceBlocks({
      messageId: `${id}-trace`,
      sessionId: id,
      turnId: `${id}-turn`,
      startSeq: 0,
      blocks: [
        {
          type: "turn_start",
          turnId: `${id}-turn`,
          sessionId: `${id}-runtime`,
          userPrompt: "Do it",
        },
      ],
    });
  }
  const reaction = async (chatId: string, key: string) =>
    (await tasks.reactionsOf(chatId, [key])).get(key) ?? null;

  /** A stopped process, then the next boot's first steps. */
  async function boot(now = Date.now()) {
    const ended = await chats.endInterruptedTurns(DAY);
    return settleMarksAfterRestart(tasks, chats, ended, now);
  }

  it("keeps a Concierge turn's marks working when startup continues that turn", async () => {
    await running("concierge");
    await tasks.markTurnWorking("concierge-turn", {
      chatId: "concierge",
      messageKey: "concierge-input",
    });
    await boot();
    expect(await reaction("concierge", "concierge-input")).toBe("working");
  });

  it("fails a Concierge turn's marks when startup does not continue it, as after a day", async () => {
    await running("concierge");
    await tasks.markTurnWorking("concierge-turn", {
      chatId: "concierge",
      messageKey: "concierge-input",
    });
    expect(await boot(Date.now() + 2 * DAY)).toBe(1);
    expect(await reaction("concierge", "concierge-input")).toBe("failed");
  });

  it("fails the marks of a task whose chat the restart ended, and keeps an idle task's", async () => {
    await running("concierge");
    await running("task-chat", "core:main", TASK_CHAT_TRIGGER_KIND);
    await chats.createSession(
      "idle-chat",
      "idle",
      undefined,
      "default",
      null,
      "default",
      "core:main",
    );
    const [cut, idle] = await tasks.upsertMany([
      { title: "Cut", state: "doing", sessionId: "task-chat", chatId: "concierge" },
      { title: "Asking", state: "doing", sessionId: "idle-chat", chatId: "concierge" },
    ]);
    await tasks.markWorking(cut!.id, { chatId: "concierge", messageKey: "cut-ask" });
    await tasks.markWorking(idle!.id, { chatId: "concierge", messageKey: "idle-ask" });
    await boot();
    // A task chat is never continued after a restart, so its work failed.
    expect(await reaction("concierge", "cut-ask")).toBe("failed");
    // A task waiting on its owner had no turn running: it still works.
    expect(await reaction("concierge", "idle-ask")).toBe("working");
  });

  it("leaves a result the process held unsaid for the Concierge to be told again", async () => {
    await running("concierge");
    const [task] = await tasks.upsertMany([{ title: "Done", state: "doing", chatId: "concierge" }]);
    await tasks.markWorking(task!.id, { chatId: "concierge", messageKey: "done-ask" });
    await tasks.holdReactions(task!.id, "done");
    await boot(Date.now() + 2 * DAY);
    expect(await reaction("concierge", "done-ask")).toBe("working");
    expect(await tasks.tasksHoldingReactions()).toEqual([task!.id]);
  });

  it("never stops boot when the marks cannot be settled", async () => {
    await running("concierge");
    const ended = await chats.endInterruptedTurns(DAY);
    const broken = {
      failInterruptedReactions: async () => {
        throw new Error("database is locked");
      },
    };
    await expect(settleMarksAfterRestart(broken, chats, ended)).resolves.toBe(0);
  });
});
