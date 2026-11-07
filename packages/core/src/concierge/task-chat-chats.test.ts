import { beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatRef } from "../chats/storage/place.js";
import { TurnLinks } from "../sessions/turn-links.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { speakerFixture } from "../test/speakers.js";
import { chatsTaskChatMessages, hasText, latestSaid, taskChatPlace } from "./task-chat.js";

// A task chat read from Chats, the way Concierge reads it: chat_read's latest
// messages, and the latest answer chat_forward and the task events quote.

describe("chatsTaskChatMessages", () => {
  let testDb: TestDb;
  let chat: ChatRef;
  let fixture: ReturnType<typeof speakerFixture>;

  beforeEach(() => {
    testDb = createTestDb();
    fixture = speakerFixture(testDb.db);
    chat = fixture.chat("webchat", "task-1", "dm", "Flights");
    fixture.speaker({ id: "task-1", chat, accountId: "guardian", createdAt: new Date(0) });
  });

  function say(id: string, at: number, fromRome: boolean, parts: unknown[]) {
    fixture.say({
      id,
      chat,
      from: fromRome ? "agent:main" : "guardian",
      agent: fromRome ? "main" : null,
      parts,
      at: new Date(at * 1000),
    });
  }

  const text = (content: string, turnPhase?: string) => ({
    type: "text",
    content,
    ...(turnPhase ? { turnPhase } : {}),
  });
  const card = { type: "pending_interaction", interaction: { kind: "question" } };
  const messages = () => chatsTaskChatMessages(testDb.db);
  const latestAnswer = async () =>
    (
      await latestSaid(
        messages(),
        taskChatPlace("task-1"),
        1,
        (message) => message.direction === "fromRome" && hasText(message),
      )
    )[0];

  it("reads the latest messages oldest first, each as its text without the narration", async () => {
    say("q", 1, false, [text("Find flights")]);
    say("a", 2, true, [text("Checking the fares.", "commentary"), text("3 options", "final")]);
    say("card", 3, true, [card]);

    const said = await latestSaid(messages(), taskChatPlace("task-1"), 5, hasText);

    expect(said.map((message) => [message.id, message.direction, message.body.text])).toEqual([
      ["q", "toRome", "Find flights"],
      ["a", "fromRome", "3 options"],
    ]);
  });

  it("finds the latest answer behind more than a page of lines without text", async () => {
    say("q", 1, false, [text("Find flights")]);
    say("a", 2, true, [text("3 options")]);
    for (let i = 0; i < 40; i++) say(`card-${i}`, 3 + i, true, [card]);

    expect((await latestAnswer())?.body.text).toBe("3 options");
  });

  it("reads Concierge's follow-up as input to the task, not as its answer", async () => {
    say("q", 1, false, [text("Find flights")]);
    say("a", 2, true, [text("3 options")]);
    const followUp = fixture.say({
      id: "follow-up",
      chat,
      from: "agent:concierge",
      agent: "concierge",
      parts: [text("Only direct ones, please")],
      at: new Date(3_000),
    });
    new TurnLinks(testDb.db).prompt(followUp, "task-1", "turn-2");

    const said = await latestSaid(messages(), taskChatPlace("task-1"), 5, hasText);
    expect(said.map((message) => [message.id, message.direction])).toEqual([
      ["q", "toRome"],
      ["a", "fromRome"],
      ["follow-up", "toRome"],
    ]);
    expect((await latestAnswer())?.body.text).toBe("3 options");
  });

  it("reads nothing for a chat Chats does not hold", async () => {
    expect(await latestSaid(messages(), taskChatPlace("missing"), 5, hasText)).toEqual([]);
  });
});
