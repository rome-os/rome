import { describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { ChatIds, chatKey, notOwnedBy, ownedBy } from "./chat-ids.js";

describe("ChatIds", () => {
  const keys = [
    chatKey("telegram", "-100123" as ChatId),
    chatKey("feishu", "dm:bot:ou_1" as ChatId),
    chatKey("discord", "telegram:odd" as ChatId),
    chatKey("webchat", "0b7c2a" as ChatId),
  ];

  it("turns a key into the chat's id and back", () => {
    for (const key of keys) expect(ChatIds.key(ChatIds.chat(key))).toEqual(key);
  });

  it("turns a message id into the chat's and back", () => {
    for (const key of keys.filter((k) => k.platform !== "webchat")) {
      const chat = ChatIds.chat(key);
      expect(ChatIds.platformMessage(chat.id, ChatIds.message(chat, "42"))).toBe("42");
    }
  });

  it("puts Rome's account in front of a basic group's message ids, and takes it off", () => {
    const basic = chatKey("telegram", "-4242" as ChatId);
    expect(ownedBy(basic, "b1", "55")).toBe("b1:55");
    expect(notOwnedBy(basic, "b1", ownedBy(basic, "b1", "55"))).toBe("55");
    const supergroup = chatKey("telegram", "-1001234567890123" as ChatId);
    expect(ownedBy(supergroup, "b1", "55")).toBe("55");
  });
});
