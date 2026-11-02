import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { ChatRepository } from "./chat-repository.js";
import { MessageRepository } from "./message-repository.js";
import type { InboundMessage } from "./message.js";
import { placeIn, type ChatRef } from "./place.js";

const ALICE = { platform: "telegram", id: "alice" };
const ROME = { platform: "telegram", id: "rome_bot" };

describe("MessageRepository", () => {
  let testDb: TestDb;
  let messages: MessageRepository;
  let chat: ChatRef;

  function heard(key: string, at: Date, text = key, threadId?: string): InboundMessage {
    return {
      direction: "toRome",
      key,
      place: placeIn(chat, threadId as ChatId | undefined),
      saidBy: { account: ALICE, name: "Alice" },
      body: { text },
      at,
    };
  }

  beforeEach(() => {
    testDb = createTestDb();
    chat = new ChatRepository(testDb.db).start(
      { platform: "telegram", externalId: "chat-1" as ChatId },
      "group",
      null,
    ).ref;
    messages = new MessageRepository(testDb.db);
  });
  afterEach(() => testDb.close());

  it("records a message once, by its key in the chat", () => {
    const at = new Date("2026-10-29T01:00:00Z");
    const recorded = messages.record(heard("m1", at, "hello"));
    expect(recorded).toMatchObject({ id: expect.any(Number), key: "m1" });
    expect(messages.record(heard("m1", at, "hello"))).toBeNull();

    expect(messages.read(placeIn(chat)).messages).toEqual([
      expect.objectContaining({
        id: recorded!.id,
        key: "m1",
        direction: "toRome",
        saidBy: { account: ALICE, name: "Alice" },
        body: { text: "hello" },
        at,
      }),
    ]);
    expect(messages.idOf(chat, "m1")).toBe(recorded!.id);
  });

  it("records the line a message quotes by its id, and nothing for a line Rome never held", () => {
    const at = new Date("2026-10-29T01:00:00Z");
    const first = messages.record(heard("m1", at))!;
    const quoting = messages.record({ ...heard("m2", at), replyTo: "m1" });
    const unknown = messages.record({ ...heard("m3", at), replyTo: "m0" });

    expect(quoting?.replyTo).toBe(first.id);
    expect(unknown?.replyTo).toBeUndefined();
  });

  it("refuses to record a message in a chat Rome does not hold", () => {
    expect(() =>
      messages.record({
        ...heard("m1", new Date()),
        place: placeIn({ platform: "x", id: chat.id + 1 }),
      }),
    ).toThrow(`No chat at x:${chat.id + 1}`);
  });

  it("records what Rome sends once the platform took it, as from Rome", async () => {
    const quoted = messages.record(heard("m0", new Date("2026-10-29T01:00:00Z")))!;
    let target: unknown;
    const sent = await messages.send(
      {
        direction: "fromRome",
        place: placeIn(chat),
        saidBy: { account: ROME, agent: "main" },
        parts: [{ type: "text", content: "hi back" }],
        replyTo: quoted.id,
      },
      async (to) => {
        target = to;
        return { key: "tg-9" };
      },
    );

    expect(target).toEqual({ chat: "chat-1", replyTo: "m0" });
    expect(sent).toMatchObject({ id: expect.any(Number), key: "tg-9", recorded: true });
    expect(messages.read(placeIn(chat)).messages.at(-1)).toEqual(
      expect.objectContaining({
        id: sent.id,
        key: "tg-9",
        direction: "fromRome",
        saidBy: { account: ROME, agent: "main" },
        body: { text: "hi back" },
        replyTo: quoted.id,
      }),
    );
  });

  it("records nothing when the platform refuses a send", async () => {
    await expect(
      messages.send(
        {
          direction: "fromRome",
          place: placeIn(chat),
          saidBy: { account: ROME, agent: "main" },
          parts: [{ type: "text", content: "x" }],
        },
        async () => {
          throw new Error("refused");
        },
      ),
    ).rejects.toThrow("refused");
    expect(messages.read(placeIn(chat)).messages).toEqual([]);
  });

  it("reads a chat and a thread in it apart", () => {
    messages.record(heard("m1", new Date("2026-10-29T01:00:00Z")));
    messages.record(heard("t1", new Date("2026-10-29T01:00:01Z"), "t1", "topic-1"));

    expect(messages.read(placeIn(chat)).messages.map((m) => m.key)).toEqual(["m1"]);
    expect(messages.read(placeIn(chat, "topic-1" as ChatId)).messages.map((m) => m.key)).toEqual([
      "t1",
    ]);
  });

  it("pages older messages before a cursor and newer ones after it", () => {
    for (let i = 1; i <= 5; i++)
      messages.record(heard(`m${i}`, new Date(Date.UTC(2026, 9, 29, 1, 0, i))));

    const newest = messages.read(placeIn(chat), { limit: 2 });
    expect(newest.messages.map((m) => m.key)).toEqual(["m4", "m5"]);
    const older = messages.read(placeIn(chat), { before: newest.older, limit: 2 });
    expect(older.messages.map((m) => m.key)).toEqual(["m2", "m3"]);

    const first = messages.read(placeIn(chat), {
      after: { at: new Date(Date.UTC(2026, 9, 29, 1, 0, 1)) },
      limit: 2,
    });
    expect(first.messages.map((m) => m.key)).toEqual(["m2", "m3"]);
    const next = messages.read(placeIn(chat), { after: first.newer!, limit: 2 });
    expect(next.messages.map((m) => m.key)).toEqual(["m4", "m5"]);
    expect(next.newer).toBeNull();
  });

  it("finds messages by id wherever they were said, in the order said", () => {
    const m2 = messages.record(heard("m2", new Date("2026-10-29T01:00:02Z")))!;
    const t1 = messages.record(heard("t1", new Date("2026-10-29T01:00:01Z"), "t1", "topic-1"))!;

    expect(
      messages.byIds([m2.id, t1.id, t1.id + 100]).map((m) => [m.key, m.place.threadId]),
    ).toEqual([
      ["t1", "topic-1"],
      ["m2", undefined],
    ]);
  });
});
