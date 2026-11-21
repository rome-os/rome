import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { and, eq } from "drizzle-orm";
import { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import { conciergeMessageTurns } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { TASK_CHAT_TRIGGER_KIND } from "../webchat/privacy.js";
import { settleMarksAfterRestart } from "./restart-marks.js";
import { ConciergeTasks } from "./tasks.js";

// The messages a killed Rome process leaves open, settled when the next one
// boots. The state is written the way a running process writes it; the
// process then dies, so no turn ends.

const DAY = 24 * 60 * 60 * 1000;

describe("messages after a restart", () => {
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
  /** Whether the turn that took message `key` of chat `chatId` has answered it, or null when none took it. */
  const answered = async (chatId: string, key: string) => {
    const [row] = await db.db
      .select({ answeredAt: conciergeMessageTurns.answeredAt })
      .from(conciergeMessageTurns)
      .where(
        and(eq(conciergeMessageTurns.chatId, chatId), eq(conciergeMessageTurns.messageKey, key)),
      );
    return row ? row.answeredAt !== null : null;
  };

  const status = async (chatId: string, key: string) =>
    (await new ConciergeTasks(tasks).messageStatusesOf(chatId, [key])).get(key) ?? null;

  /** A stopped process, then the next boot's first steps. */
  async function boot(now = Date.now()) {
    const ended = await chats.endInterruptedTurns(DAY);
    return settleMarksAfterRestart(tasks, chats, ended, now);
  }

  it("keeps a Concierge turn's messages open when startup continues that turn", async () => {
    await running("concierge");
    await tasks.takeMessage("concierge-turn", {
      chatId: "concierge",
      messageKey: "concierge-input",
    });
    await boot();
    expect(await answered("concierge", "concierge-input")).toBe(false);
  });

  it("answers a Concierge turn's messages when startup does not continue it, as after a day, so none stays open", async () => {
    await running("concierge");
    await tasks.takeMessage("concierge-turn", {
      chatId: "concierge",
      messageKey: "concierge-input",
    });
    expect(await boot(Date.now() + 2 * DAY)).toBe(1);
    expect(await answered("concierge", "concierge-input")).toBe(true);
  });

  it("settles every working status a turn the restart cut off left, as failed", async () => {
    await running("concierge");
    await running("topic", "core:concierge");
    for (const chatId of ["concierge", "topic"]) {
      await tasks.takeMessage(`${chatId}-turn`, { chatId, messageKey: `${chatId}-input` });
      await tasks.markWorking(chatId);
      expect(await status(chatId, `${chatId}-input`)).toBe("working");
    }
    await boot(Date.now() + 2 * DAY);
    expect(await status("concierge", "concierge-input")).toBe("failed");
    expect(await status("topic", "topic-input")).toBe("failed");
  });

  it("leaves a message the cut-off turn reacted to with no status", async () => {
    await running("concierge");
    await tasks.takeMessage("concierge-turn", {
      chatId: "concierge",
      messageKey: "concierge-input",
    });
    await tasks.markReacted("concierge", "concierge-input");
    await boot(Date.now() + 2 * DAY);
    expect(await status("concierge", "concierge-input")).toBeNull();
  });

  it("shows a turn startup continues working", async () => {
    await running("concierge");
    await tasks.takeMessage("concierge-turn", {
      chatId: "concierge",
      messageKey: "concierge-input",
    });
    await boot();
    expect(await status("concierge", "concierge-input")).toBe("working");
  });

  it("ends failed a task whose chat the restart ended, and leaves an idle task as it was", async () => {
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
    const cut = await tasks.create("task-chat", { chatId: "concierge" });
    const idle = await tasks.create("idle-chat", { chatId: "concierge" });
    await tasks.linkMessage(cut!.id, { chatId: "concierge", messageKey: "cut-ask" });
    await boot();
    // A task chat is never continued after a restart, so its work failed. Its
    // result is unsaid, so the Concierge is told on catch-up, and the message
    // works until it is.
    expect(await tasks.get(cut!.id)).toMatchObject({ lastOutcome: "failed", outcomeUnsaid: true });
    expect(await status("concierge", "cut-ask")).toBe("working");
    await tasks.markReported([cut!.id]);
    expect(await status("concierge", "cut-ask")).toBe("failed");
    // A task with no turn running and no result was untouched.
    expect((await tasks.get(idle!.id))?.lastOutcome).toBeNull();
  });

  it("leaves a result the process held unsaid for the Concierge to be told again", async () => {
    await running("concierge");
    await chats.createSession("done-chat", "Done");
    const task = await tasks.create("done-chat", { chatId: "concierge" });
    await tasks.setLastOutcome(task!.id, "succeeded");
    await boot(Date.now() + 2 * DAY);
    expect(await tasks.tasksWithUnsaidOutcome()).toEqual([task!.id]);
  });

  it("never stops boot when the messages cannot be settled", async () => {
    await running("concierge");
    const ended = await chats.endInterruptedTurns(DAY);
    const broken = {
      answerInterrupted: async () => {
        throw new Error("database is locked");
      },
      findBySession: async () => null,
      setLastOutcome: async () => {},
    };
    await expect(settleMarksAfterRestart(broken, chats, ended)).resolves.toBe(0);
  });
});
