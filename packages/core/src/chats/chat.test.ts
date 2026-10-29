import { describe, expect, it } from "@rstest/core";
import type { ChatId, StoredChatSettings } from "@rome-os/app-runtime";
import { Chat, ChatRefusal } from "./chat.js";
import { chatKey } from "./place.js";

const KEY = chatKey("feishu", "oc_group" as ChatId);
const SALES = { platform: "feishu", id: "ou_sales" };
const SUPPORT = { platform: "feishu", id: "ou_support" };
const ALICE = { platform: "feishu", id: "ou_alice" };

const RULE: StoredChatSettings = {
  schemaVersion: 1,
  overrides: { activation: { mode: "all" } },
  updatedAt: "2026-10-29T00:00:00.000Z",
  updatedBy: { kind: "guardian" },
};

describe("Chat", () => {
  it("starts with the account that carried its first message as one of Rome's", () => {
    const chat = Chat.start(KEY, "group", SALES, "Launch");

    expect(chat.participants).toEqual([{ account: SALES, romes: true }]);
    expect(chat.isRomes(SALES)).toBe(true);
    expect(chat.replyRule).toBeNull();
    expect(chat.ended).toBe(false);
  });

  it("refuses to start through an account on another platform", () => {
    expect(() => Chat.start(KEY, "group", { platform: "lark", id: "ou_sales" }, null)).toThrow(
      ChatRefusal,
    );
  });

  it("takes the platform's member list, one participant per account", () => {
    const chat = Chat.start(KEY, "group", SALES, null);

    chat.setParticipants([
      { account: ALICE, romes: false },
      { account: SALES, romes: true },
      { account: ALICE, romes: false },
    ]);

    expect(chat.participants).toEqual([
      { account: ALICE, romes: false },
      { account: SALES, romes: true },
    ]);
  });

  it("refuses a member from another platform and keeps the list it had", () => {
    const chat = Chat.start(KEY, "group", SALES, null);

    expect(() =>
      chat.setParticipants([
        { account: SALES, romes: true },
        { account: { platform: "telegram", id: "42" }, romes: false },
      ]),
    ).toThrow(ChatRefusal);
    expect(chat.participants).toEqual([{ account: SALES, romes: true }]);
  });

  it("ends when the last of Rome's accounts leaves, and then refuses every change", () => {
    const chat = Chat.start(KEY, "group", SALES, null);
    chat.setReplyRule(SALES, RULE);

    chat.setParticipants([{ account: ALICE, romes: false }]);

    expect(chat.ended).toBe(true);
    expect(chat.replyRule).toBeNull();
    expect(() => chat.setReplyRule(SALES, RULE)).toThrow(ChatRefusal);
    expect(() => chat.rename("Later")).toThrow(ChatRefusal);
    expect(() => chat.end()).toThrow(ChatRefusal);
  });

  it("stays live while another of Rome's accounts is still in it", () => {
    const chat = Chat.start(KEY, "group", SALES, null);
    chat.setParticipants([
      { account: SALES, romes: true },
      { account: SUPPORT, romes: true },
    ]);
    chat.setReplyRule(SALES, RULE);

    chat.setParticipants([{ account: SUPPORT, romes: true }]);

    expect(chat.ended).toBe(false);
    expect(chat.replyRule).toEqual(RULE);
  });

  it("sets the reply rule only for one of Rome's accounts in the chat", () => {
    const chat = Chat.start(KEY, "group", SALES, null);
    chat.setParticipants([
      { account: SALES, romes: true },
      { account: ALICE, romes: false },
    ]);

    expect(() => chat.setReplyRule(ALICE, RULE)).toThrow(ChatRefusal);
    expect(() => chat.setReplyRule(SUPPORT, RULE)).toThrow(ChatRefusal);
    chat.setReplyRule(SALES, RULE);
    expect(chat.replyRule).toEqual(RULE);
    chat.setReplyRule(SALES, null);
    expect(chat.replyRule).toBeNull();
  });

  it.each([
    "webchat",
    "agents",
  ])("keeps the rule fixed on %s, where Rome is the platform", (platform) => {
    const via = { platform, id: "rome" };
    const chat = Chat.start(chatKey(platform, "chat-1" as ChatId), "dm", via, null);

    expect(() => chat.setReplyRule(via, RULE)).toThrow(ChatRefusal);
  });

  it("refuses to restore a live chat with none of Rome's accounts in it", () => {
    expect(() =>
      Chat.restore({
        key: KEY,
        kind: "group",
        name: null,
        participants: [{ account: ALICE, romes: false }],
        replyRule: null,
        ended: false,
      }),
    ).toThrow("none of Rome's accounts");
  });
});
