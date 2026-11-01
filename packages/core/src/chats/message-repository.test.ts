import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatRepository } from "./chat-repository.js";
import { MessageRepository } from "./message-repository.js";
import type { InboundMessage } from "./message.js";
import { placeIn } from "./place.js";

const CHAT = { platform: "telegram", id: "chat-1" };
const ALICE = { platform: "telegram", id: "alice" };
const ROME = { platform: "telegram", id: "rome_bot" };

function heard(id: string, at: Date, text = id, threadId?: string): InboundMessage {
  return {
    direction: "toRome",
    id,
    place: placeIn(CHAT, threadId as ChatId | undefined),
    saidBy: { account: ALICE, name: "Alice" },
    body: { text },
    at,
  };
}

describe("MessageRepository", () => {
  let testDb: TestDb;
  let messages: MessageRepository;

  beforeEach(() => {
    testDb = createTestDb();
    new ChatRepository(testDb.db).start(CHAT, "group", null);
    messages = new MessageRepository(testDb.db);
  });
  afterEach(() => testDb.close());

  it("records a message once", () => {
    const at = new Date("2026-10-29T01:00:00Z");
    expect(messages.record(heard("m1", at, "hello"))).not.toBeNull();
    expect(messages.record(heard("m1", at, "hello"))).toBeNull();

    expect(messages.read(placeIn(CHAT)).messages).toEqual([
      expect.objectContaining({
        id: "m1",
        direction: "toRome",
        saidBy: { account: ALICE, name: "Alice" },
        body: { text: "hello" },
        at,
      }),
    ]);
  });

  it("refuses to record a message in a chat Rome does not hold", () => {
    expect(() =>
      messages.record({ ...heard("m1", new Date()), place: placeIn({ platform: "x", id: "y" }) }),
    ).toThrow("No chat at x:y");
  });

  it("records what Rome sends once the platform took it, as from Rome", async () => {
    const sent = await messages.send(
      {
        direction: "fromRome",
        place: placeIn(CHAT),
        saidBy: { account: ROME, agent: "main" },
        parts: [{ type: "text", content: "hi back" }],
        replyTo: "m0",
      },
      async () => ({ id: "tg-9" }),
    );

    expect(sent).toMatchObject({ id: "tg-9", recorded: true });
    expect(messages.read(placeIn(CHAT)).messages).toEqual([
      expect.objectContaining({
        id: "tg-9",
        direction: "fromRome",
        saidBy: { account: ROME, agent: "main" },
        body: { text: "hi back" },
        replyTo: "m0",
      }),
    ]);
  });

  it("records nothing when the platform refuses a send", async () => {
    await expect(
      messages.send(
        {
          direction: "fromRome",
          place: placeIn(CHAT),
          saidBy: { account: ROME, agent: "main" },
          parts: [{ type: "text", content: "x" }],
        },
        async () => {
          throw new Error("refused");
        },
      ),
    ).rejects.toThrow("refused");
    expect(messages.read(placeIn(CHAT)).messages).toEqual([]);
  });

  it("reads a chat and a thread in it apart", () => {
    messages.record(heard("m1", new Date("2026-10-29T01:00:00Z")));
    messages.record(heard("t1", new Date("2026-10-29T01:00:01Z"), "t1", "topic-1"));

    expect(messages.read(placeIn(CHAT)).messages.map((m) => m.id)).toEqual(["m1"]);
    expect(messages.read(placeIn(CHAT, "topic-1" as ChatId)).messages.map((m) => m.id)).toEqual([
      "t1",
    ]);
  });

  it("pages older messages before a cursor and newer ones after it", () => {
    for (let i = 1; i <= 5; i++)
      messages.record(heard(`m${i}`, new Date(Date.UTC(2026, 9, 29, 1, 0, i))));

    const newest = messages.read(placeIn(CHAT), { limit: 2 });
    expect(newest.messages.map((m) => m.id)).toEqual(["m4", "m5"]);
    const older = messages.read(placeIn(CHAT), { before: newest.older, limit: 2 });
    expect(older.messages.map((m) => m.id)).toEqual(["m2", "m3"]);

    const first = messages.read(placeIn(CHAT), {
      after: { at: new Date(Date.UTC(2026, 9, 29, 1, 0, 1)) },
      limit: 2,
    });
    expect(first.messages.map((m) => m.id)).toEqual(["m2", "m3"]);
    const next = messages.read(placeIn(CHAT), { after: first.newer!, limit: 2 });
    expect(next.messages.map((m) => m.id)).toEqual(["m4", "m5"]);
    expect(next.newer).toBeNull();
  });

  it("finds messages by id wherever they were said, in the order said", () => {
    messages.record(heard("m2", new Date("2026-10-29T01:00:02Z")));
    messages.record(heard("t1", new Date("2026-10-29T01:00:01Z"), "t1", "topic-1"));

    expect(messages.byIds(["m2", "t1", "missing"]).map((m) => [m.id, m.place.threadId])).toEqual([
      ["t1", "topic-1"],
      ["m2", undefined],
    ]);
  });
});
