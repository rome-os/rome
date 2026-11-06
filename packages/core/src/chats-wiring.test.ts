import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { Account, ChatId } from "@rome-os/app-runtime";
import { chatsWiring } from "./chats-wiring.js";
import { chatKey } from "./connections/chat-ids.js";
import { createTestDb, type TestDb } from "./test/helpers.js";

const BOT: Account = { platform: "telegram", id: "bot-1" };

describe("chatsWiring", () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => testDb.close());

  function wiring() {
    return chatsWiring(testDb.db, {
      accountOf: (channel) => (channel === "telegram" ? BOT : null),
      platformOfChannel: (channel) => (channel === "telegram" ? "telegram" : channel),
      channelsOn: (platform) => (platform === "telegram" ? ["telegram"] : []),
    });
  }

  it("keys a chat it holds by the platform's id for it", () => {
    const chats = wiring();
    const chat = chats.chats.start(chatKey("telegram", "-100" as ChatId), "group", "Team");
    expect(chats.adapters.keyOf(chat.ref)).toEqual(chatKey("telegram", "-100" as ChatId));
  });

  it("refuses to key a chat it does not hold", () => {
    expect(() => wiring().adapters.keyOf({ platform: "telegram", id: 999 })).toThrow(
      "No chat telegram:999",
    );
  });

  it("finds the channel of Rome's account", () => {
    expect(wiring().adapters.channelOf(BOT)).toBe("telegram");
  });

  it("leaves a channel that cannot send as it is", () => {
    const channel = { name: "telegram", send: null } as never;
    expect(wiring().recordedSends([channel])).toEqual([channel]);
  });
});
