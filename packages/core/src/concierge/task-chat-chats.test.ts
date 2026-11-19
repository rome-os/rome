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
    const links = () => new TurnLinks(testDb.db);
    /** The guardian's prompt that woke `turn`. */
    const ask = (id: string, at: number, turn: string) =>
      links().prompt(said(id, at, false, [text(id)]), "task-1", turn);
    /** What the agent said in `turn`. */
    const answer = (id: string, at: number, turn: string, parts: unknown[]) =>
      links().answer(said(id, at, true, parts), "task-1", turn);
    function said(id: string, at: number, fromRome: boolean, parts: unknown[]) {
      return fixture.say({
        id,
        chat,
        from: fromRome ? "agent:main" : "guardian",
        agent: fromRome ? "main" : null,
        parts,
        at: new Date(at * 1000),
      });
    }

    it("gives the answer with the card its turn showed, before or after it", async () => {
      ask("q", 1, "t1");
      answer("card", 2, "t1", [agentCard("Sleep 6.1 h")]);
      answer("a", 3, "t1", [text("Your summary.")]);

      const found = await final();
      expect(found?.answer?.id).toBe("a");
      expect(found?.card).toMatchObject({ appId: "core", text: "Sleep 6.1 h" });

      ask("q2", 4, "t2");
      answer("a2", 5, "t2", [text("Today's summary.")]);
      answer("card2", 6, "t2", [agentCard("Today")]);
      expect(await final()).toMatchObject({ answer: { id: "a2" }, card: { text: "Today" } });
    });

    it("makes a card the answer of a turn that showed only a card, never an earlier turn's text", async () => {
      ask("q", 1, "t1");
      answer("a", 2, "t1", [text("Yesterday's summary.")]);
      ask("q2", 3, "t2");
      answer("card", 4, "t2", [agentCard("Today")]);

      const found = await final();
      expect(found?.answer).toBeUndefined();
      expect(found?.card?.text).toBe("Today");
    });

    it("never pairs an answer with an earlier turn's card when no prompt lies between them", async () => {
      // A defer wake-up or an approval's resumption answers with no prompt row.
      ask("q", 1, "t1");
      answer("old-card", 2, "t1", [agentCard("Yesterday")]);
      answer("old", 3, "t1", [text("Yesterday's summary.")]);
      answer("a", 4, "t2", [text("Checked again: nothing new.")]);

      const found = await final();
      expect(found?.answer?.id).toBe("a");
      expect(found?.card).toBeUndefined();
    });

    it("gives no card for an answer that showed none, nor for an app's card", async () => {
      ask("q", 1, "t1");
      answer("w", 2, "t1", [{ ...agentCard("Sunny"), appId: "weather" }]);
      answer("a", 3, "t1", [text("Sunny.")]);

      const found = await final();
      expect(found?.answer?.id).toBe("a");
      expect(found?.card).toBeUndefined();
    });

    it("lets a message no turn is linked to answer alone", async () => {
      ask("q", 1, "t1");
      answer("card", 2, "t1", [agentCard("Sleep")]);
      say("a", 3, true, [text("An older row.")]);

      expect(await final()).toEqual({ answer: expect.objectContaining({ id: "a" }) });
    });
  });

  it("reads nothing for a chat Chats does not hold", async () => {
    expect(await latestSaid(messages(), taskChatPlace("missing"), 5, hasText)).toEqual([]);
  });
});
