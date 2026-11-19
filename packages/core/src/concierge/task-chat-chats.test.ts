import { beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatRef } from "../chats/storage/place.js";
import { TurnLinks } from "../sessions/turn-links.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { speakerFixture } from "../test/speakers.js";
import {
  chatsTaskChatMessages,
  finalAnswer,
  hasText,
  latestSaid,
  taskChatPlace,
} from "./task-chat.js";

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

  describe("finalAnswer", () => {
    const agentCard = (text: string) => ({
      type: "widget",
      toolUseId: `call-${text}`,
      appId: "core",
      text,
      ui: { components: [{ id: "root", component: "Text", text }] },
    });
    const final = () => finalAnswer(messages(), taskChatPlace("task-1"));

    it("gives the answer with the card its turn showed, which is never the answer itself", async () => {
      say("q", 1, false, [text("Daily summary")]);
      say("card", 2, true, [agentCard("Sleep 6.1 h")]);
      say("a", 3, true, [text("Your summary.")]);

      const found = await final();
      expect(found?.answer.id).toBe("a");
      expect(found?.card).toMatchObject({ appId: "core", text: "Sleep 6.1 h" });
    });

    it("takes a card said after the answer in the same turn, but no other turn's", async () => {
      say("q", 1, false, [text("Daily summary")]);
      say("old-card", 2, true, [agentCard("Yesterday")]);
      say("old", 3, true, [text("Yesterday's summary.")]);
      say("q2", 4, false, [text("Again")]);
      say("a", 5, true, [text("Today's summary.")]);
      say("card", 6, true, [agentCard("Today")]);
      say("q3", 7, false, [text("And tomorrow?")]);
      say("running", 8, true, [agentCard("Not yet")]);

      const found = await final();
      expect(found?.answer.id).toBe("a");
      expect(found?.card?.text).toBe("Today");
    });

    it("gives no card for an answer that showed none, nor for an app's card", async () => {
      say("q", 1, false, [text("Weather")]);
      say("w", 2, true, [{ ...agentCard("Sunny"), appId: "weather" }]);
      say("a", 3, true, [text("Sunny.")]);

      const found = await final();
      expect(found?.answer.id).toBe("a");
      expect(found?.card).toBeUndefined();
    });
  });

  it("reads nothing for a chat Chats does not hold", async () => {
    expect(await latestSaid(messages(), taskChatPlace("missing"), 5, hasText)).toEqual([]);
  });
});
