// The personal-WeChat people-timeline source: a live Messages store and an
// address book, both over the reader.
//
// Seams under test:
//   1. read maps reader rows to the timeline shape, newest-first, and pages
//      after a cursor.
//   2. count sums per-contact counts; latest is the newest across contacts.
//   3. the address book lists direct contacts (never groups) and resolves a wxid.

import { describe, expect, it } from "@rstest/core";
import { messageCursor, parseMessageCursor } from "@rome/api-types/message";
import type { WechatUserConversation, WechatUserMessage, WechatUserReader } from "./wechat-user.js";
import { wechatUserAccounts, wechatUserMessages } from "./wechat-user-messages.js";

const msg = (over: Partial<WechatUserMessage>): WechatUserMessage => ({
  id: "wxid_a:1",
  conversationId: "wxid_a",
  isGroup: false,
  senderId: "wxid_a",
  isSelf: false,
  timestamp: 1000,
  type: "text",
  text: "hi",
  ...over,
});

const convo = (over: Partial<WechatUserConversation>): WechatUserConversation => ({
  id: "wxid_a",
  name: "Alice",
  isGroup: false,
  unread: 0,
  ...over,
});

function fakeReader(opts: {
  byConversation?: Record<string, WechatUserMessage[]>;
  conversations?: WechatUserConversation[];
}): WechatUserReader {
  return {
    async messages(input: { conversationId?: string; before?: Date; since?: Date; limit: number }) {
      let rows = opts.byConversation?.[input.conversationId ?? ""] ?? [];
      if (input.before) {
        const before = Math.floor(input.before.getTime() / 1000);
        rows = rows.filter((m) => m.timestamp <= before);
      }
      // The reader answers newest-first; mimic that before applying the limit.
      return [...rows].sort((a, b) => b.timestamp - a.timestamp).slice(0, input.limit);
    },
    async count(conversationId: string) {
      return (opts.byConversation?.[conversationId] ?? []).length;
    },
    async conversations(input: { query?: string; limit: number }) {
      let rows = opts.conversations ?? [];
      if (input.query) rows = rows.filter((c) => c.name.includes(input.query!));
      return rows.slice(0, input.limit);
    },
  } as unknown as WechatUserReader;
}

const account = (address: string) => ({ channel: "wechat_user", addresses: [address] });

describe("wechatUserMessages", () => {
  it("maps reader rows to the timeline shape, newest-first", async () => {
    const store = wechatUserMessages(
      fakeReader({
        byConversation: {
          wxid_a: [
            msg({ id: "wxid_a:1", timestamp: 1000, text: "first", isSelf: false }),
            msg({ id: "wxid_a:2", timestamp: 2000, text: "second", isSelf: true }),
          ],
        },
      }),
    );

    const page = await store.read({ accounts: [account("wxid_a")], limit: 10 });

    expect(page.map((m) => m.ref)).toEqual(["wxid_a:2", "wxid_a:1"]);
    expect(page[0]).toMatchObject({
      source: "wechat_user",
      timestamp: 2000,
      body: "second",
      direction: "outbound",
    });
    expect(page[1]).toMatchObject({ direction: "inbound", body: "first" });
  });

  it("pages strictly after a cursor", async () => {
    const store = wechatUserMessages(
      fakeReader({
        byConversation: {
          wxid_a: [
            msg({ id: "wxid_a:1", timestamp: 1000 }),
            msg({ id: "wxid_a:2", timestamp: 2000 }),
            msg({ id: "wxid_a:3", timestamp: 3000 }),
          ],
        },
      }),
    );

    const first = await store.read({ accounts: [account("wxid_a")], limit: 1 });
    expect(first.map((m) => m.ref)).toEqual(["wxid_a:3"]);

    const next = await store.read({
      accounts: [account("wxid_a")],
      after: first[0],
      limit: 10,
    });
    expect(next.map((m) => m.ref)).toEqual(["wxid_a:2", "wxid_a:1"]);
    // The cursor round-trips through the message module.
    expect(parseMessageCursor(messageCursor(first[0]!))?.ref).toBe("wxid_a:3");
  });

  it("counts and previews across a person's contacts", async () => {
    const store = wechatUserMessages(
      fakeReader({
        byConversation: {
          wxid_a: [msg({ id: "wxid_a:1", timestamp: 1000 })],
          wxid_b: [
            msg({ id: "wxid_b:1", conversationId: "wxid_b", timestamp: 500 }),
            msg({ id: "wxid_b:2", conversationId: "wxid_b", timestamp: 4000 }),
          ],
        },
      }),
    );
    const accounts = [account("wxid_a"), account("wxid_b")];

    expect(await store.count(accounts)).toBe(3);
    expect((await store.latest(accounts))?.ref).toBe("wxid_b:2");
  });

  it("answers nothing for a set naming no wechat address", async () => {
    const store = wechatUserMessages(fakeReader({}));
    expect(
      await store.read({ accounts: [{ channel: "linkedin", addresses: ["x"] }], limit: 5 }),
    ).toEqual([]);
    expect(await store.latest([])).toBeNull();
    expect(await store.count([])).toBe(0);
  });
});

describe("wechatUserAccounts", () => {
  it("lists direct contacts and skips groups", async () => {
    const accounts = wechatUserAccounts(
      fakeReader({
        conversations: [
          convo({ id: "wxid_a", name: "Alice" }),
          convo({ id: "room@chatroom", name: "Team", isGroup: true }),
          convo({ id: "wxid_b", name: "Bob" }),
        ],
      }),
    );

    const listed = await accounts.listAccounts({ limit: 50 });
    expect(listed.accounts.map((a) => a.id)).toEqual(["wxid_a", "wxid_b"]);
    expect(listed.accounts[0]).toMatchObject({
      addresses: ["wxid_a"],
      name: "Alice",
      identifiers: { "wechat:wxid": "wxid_a" },
    });
  });

  it("resolves a wxid to its account and misses a group", async () => {
    const accounts = wechatUserAccounts(
      fakeReader({
        conversations: [
          convo({ id: "wxid_a", name: "Alice" }),
          convo({ id: "room@chatroom", name: "Team", isGroup: true }),
        ],
      }),
    );

    expect((await accounts.resolve("wxid_a"))?.name).toBe("Alice");
    expect(await accounts.resolve("room@chatroom")).toBeNull();
    expect(await accounts.resolve("wxid_unknown")).toBeNull();
  });
});
