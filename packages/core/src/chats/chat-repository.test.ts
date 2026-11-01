import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatRepository, chatIdsOfKind, chatIdsOn } from "./chat-repository.js";
import { MessageRepository } from "./message-repository.js";
import { placeIn } from "./place.js";

describe("ChatRepository", () => {
  let testDb: TestDb;
  let chats: ChatRepository;

  beforeEach(() => {
    testDb = createTestDb();
    chats = new ChatRepository(testDb.db);
  });
  afterEach(() => testDb.close());

  const GROUP = { platform: "feishu", id: "oc_group" };
  const DM = { platform: "feishu", id: "dm:feishu:bot:ou_alice" };

  it("starts a chat once and answers it as stored after", () => {
    const first = chats.start(GROUP, "group", "Launch");
    const again = chats.start(GROUP, "dm", "Renamed");

    expect(first).toMatchObject({ ref: GROUP, kind: "group", name: "Launch" });
    expect(again).toEqual(first);
  });

  it("finds a chat by ref only on its own platform", () => {
    chats.start(GROUP, "group", null);

    expect(chats.get(GROUP)?.kind).toBe("group");
    expect(chats.get({ platform: "lark", id: GROUP.id })).toBeNull();
    expect(chats.find(GROUP.id)?.ref).toEqual(GROUP);
    expect(chats.find("missing")).toBeNull();
  });

  it("lists a platform's chats", () => {
    chats.start(GROUP, "group", null);
    chats.start(DM, "dm", null);
    chats.start({ platform: "telegram", id: "42" }, "dm", null);

    expect(
      chats
        .list("feishu")
        .map((chat) => chat.ref.id)
        .sort(),
    ).toEqual([DM.id, GROUP.id]);
  });

  it("renames a chat", () => {
    chats.start(GROUP, "group", null);
    chats.rename(GROUP, "Launch");

    expect(chats.get(GROUP)?.name).toBe("Launch");
  });

  it("ends a chat with every message said in it", () => {
    chats.start(GROUP, "group", null);
    const messages = new MessageRepository(testDb.db);
    messages.record({
      direction: "toRome",
      id: "om_1",
      place: placeIn(GROUP),
      saidBy: { account: { platform: "feishu", id: "ou_alice" } },
      body: { text: "hi" },
      at: new Date(),
    });

    chats.end(GROUP);

    expect(chats.get(GROUP)).toBeNull();
    expect(messages.read(placeIn(GROUP)).messages).toEqual([]);
  });

  it("names a platform's and a kind's chats as subqueries", () => {
    chats.start(GROUP, "group", null);
    chats.start(DM, "dm", null);

    const ids = (where: ReturnType<typeof sql>) =>
      testDb.db
        .all<{ id: string }>(sql`SELECT id FROM chats WHERE id IN ${where} ORDER BY id`)
        .map((row) => row.id);
    expect(ids(chatIdsOn("feishu"))).toEqual([DM.id, GROUP.id]);
    expect(ids(chatIdsOfKind("dm"))).toEqual([DM.id]);
  });
});
