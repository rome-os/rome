import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, testChatWiring, type TestDb } from "../test/helpers.js";
import { startChannelChat } from "./open-chat.js";

describe("startChannelChat", () => {
  let testDb: TestDb;
  let deps: ReturnType<typeof testChatWiring>;

  beforeEach(() => {
    testDb = createTestDb();
    deps = testChatWiring(testDb.db);
  });
  afterEach(() => testDb.close());

  it("starts a group chat at its address, named, with Rome's account as its end", () => {
    const started = startChannelChat(deps, {
      channel: "telegram",
      threadId: "-100",
      threadType: "group",
      threadName: "Launch",
    });

    expect(deps.chats.find(started.chat.id)).toMatchObject({ kind: "group", name: "Launch" });
    expect(started.romeEnd).toBe(deps.adapters.accountOn("telegram").id);
  });

  it("starts a direct message for a private address", () => {
    const started = startChannelChat(deps, {
      channel: "telegram",
      threadId: "42",
      threadType: "private",
      threadName: "Alice",
    });

    expect(deps.chats.find(started.chat.id)?.kind).toBe("dm");
  });

  it("starts a thread's parent chat, unnamed, and no chat for the thread", () => {
    const started = startChannelChat(deps, {
      channel: "telegram",
      threadId: "-100:7",
      parentThreadId: "-100",
      threadName: "Topic",
    });

    expect(deps.chats.find(started.chat.id)).toMatchObject({ kind: "group", name: null });
    expect(deps.chats.list(deps.adapters.accountOn("telegram").platform)).toHaveLength(1);
  });

  it("answers the same chat for the same address", () => {
    const a = startChannelChat(deps, {
      channel: "telegram",
      threadId: "42",
      threadType: "private",
    });
    const b = startChannelChat(deps, {
      channel: "telegram",
      threadId: "42",
      threadType: "private",
    });

    expect(b.chat).toEqual(a.chat);
  });
});
