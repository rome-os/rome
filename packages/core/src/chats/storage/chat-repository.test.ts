import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { ChatRepository, chatIdsOfKind, chatIdsOn } from "./chat-repository.js";
import { MessageRepository } from "./message-repository.js";
import { placeIn, type ChatKey } from "./place.js";

describe("ChatRepository", () => {
  let testDb: TestDb;
  let chats: ChatRepository;

  beforeEach(() => {
    testDb = createTestDb();
    chats = new ChatRepository(testDb.db);
  });
  afterEach(() => testDb.close());

  const key = (platform: string, externalId: string): ChatKey => ({
    platform,
    externalId: externalId as ChatId,
  });
  const GROUP = key("feishu", "oc_group");
  const DM = key("feishu", "dm:bot:ou_alice");

  it("starts a chat once, keyed by its adapter's key, and answers it as stored after", () => {
    const first = chats.start(GROUP, "group", "Launch");
    const again = chats.start(GROUP, "dm", "Renamed");

    expect(first).toMatchObject({ key: "oc_group", kind: "group", name: "Launch" });
    expect(first.ref).toEqual({ platform: "feishu", id: expect.any(Number) });
    expect(again).toEqual(first);
  });

  it("gives the same key on two platforms two chats", () => {
    const feishu = chats.start(GROUP, "group", null);
    const lark = chats.start(key("lark", "oc_group"), "group", null);

    expect(lark.ref.id).not.toBe(feishu.ref.id);
    expect(chats.byKey(key("lark", "oc_group"))?.ref).toEqual(lark.ref);
  });

  it("finds a chat by ref only on its own platform", () => {
    const { ref } = chats.start(GROUP, "group", null);

    expect(chats.get(ref)?.kind).toBe("group");
    expect(chats.get({ platform: "lark", id: ref.id })).toBeNull();
    expect(chats.find(ref.id)?.ref).toEqual(ref);
    expect(chats.find(ref.id + 1)).toBeNull();
    expect(chats.byKey(key("feishu", "missing"))).toBeNull();
  });

  it("lists a platform's chats", () => {
    chats.start(GROUP, "group", null);
    chats.start(DM, "dm", null);
    chats.start(key("telegram", "42"), "dm", null);

    expect(
      chats
        .list("feishu")
        .map((chat) => chat.key)
        .sort(),
    ).toEqual([DM.externalId, GROUP.externalId]);
  });

  it("renames a chat", () => {
    const { ref } = chats.start(GROUP, "group", null);
    chats.rename(ref, "Launch");

    expect(chats.get(ref)?.name).toBe("Launch");
  });

  it("ends a chat with every message said in it", () => {
    const { ref } = chats.start(GROUP, "group", null);
    const messages = new MessageRepository(testDb.db);
    messages.record({
      direction: "toRome",
      key: "om_1",
      place: placeIn(ref),
      saidBy: { account: { platform: "feishu", id: "ou_alice" } },
      body: { text: "hi" },
      at: new Date(),
    });

    chats.end(ref);

    expect(chats.get(ref)).toBeNull();
    expect(messages.read(placeIn(ref)).messages).toEqual([]);
  });

  it("renames and ends a chat only by a ref on its own platform", () => {
    const { ref } = chats.start(GROUP, "group", "Launch");
    const wrong = { platform: "lark", id: ref.id };

    chats.rename(wrong, "Other");
    chats.end(wrong);

    expect(chats.get(ref)?.name).toBe("Launch");
  });

  it("names a platform's and a kind's chats as subqueries", () => {
    const group = chats.start(GROUP, "group", null).ref.id;
    const dm = chats.start(DM, "dm", null).ref.id;

    const ids = (where: ReturnType<typeof sql>) =>
      testDb.db
        .all<{ id: number }>(sql`SELECT id FROM chats WHERE id IN ${where} ORDER BY id`)
        .map((row) => row.id);
    expect(ids(chatIdsOn("feishu"))).toEqual([group, dm]);
    expect(ids(chatIdsOfKind("dm"))).toEqual([dm]);
  });
});
