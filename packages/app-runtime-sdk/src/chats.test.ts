import { describe, expect, it } from "@rstest/core";
import type { Account } from "./index.js";
import {
  type ChatMessage,
  type ChatRef,
  type ChatsPort,
  chatOf,
  chatsOver,
  isSendError,
  isThreadRef,
  type Place,
  SendError,
  type SendOptions,
  type Sent,
} from "./chats.js";

const slack: ChatRef = { platform: "slack", id: 7 };
const guardian: Account = { platform: "telegram", id: "8123456789" };
const bot: Account = { platform: "telegram", id: "42" };

function fakePort(over: Partial<ChatsPort> = {}) {
  const sends: Array<{ place: Place; out: ChatMessage; opts?: SendOptions }> = [];
  let next = 100;
  const port: ChatsPort = {
    async send(place, out, opts) {
      sends.push({ place, out, opts });
      const sent: Sent = {
        message: { chat: chatOf(place), id: next++ },
        delivery: { state: "sent", at: new Date(0) },
      };
      return isThreadRef(place) ? { ...sent, thread: place } : sent;
    },
    async dm() {
      return { platform: "telegram", id: 3 };
    },
    async group() {
      return [];
    },
    ...over,
  };
  return { port, sends };
}

describe("chatsOver", () => {
  it("sends a handle's message into the chat its ref names", async () => {
    const { port, sends } = fakePort();
    const chats = chatsOver(port);

    const sent = await chats.byRef(slack).send({ text: "Brief ready." }, { as: bot });

    expect(sends).toEqual([{ place: slack, out: { text: "Brief ready." }, opts: { as: bot } }]);
    expect(sent.message).toEqual({ chat: slack, id: 100 });
  });

  it("opens the direct message through the port and sends into the chat it answers", async () => {
    const asked: Array<{ account: Account; opts?: SendOptions }> = [];
    const { port, sends } = fakePort({
      async dm(account, opts) {
        asked.push({ account, opts });
        return { platform: "telegram", id: 3 };
      },
    });

    const chat = await chatsOver(port).dm(guardian, { as: bot });
    await chat.send({ text: "Hi" });

    expect(asked).toEqual([{ account: guardian, opts: { as: bot } }]);
    expect(chat.ref).toEqual({ platform: "telegram", id: 3 });
    expect(sends[0]?.place).toEqual({ platform: "telegram", id: 3 });
  });

  it("answers a handle for every group that matches", async () => {
    const other: ChatRef = { platform: "slack", id: 8 };
    const { port } = fakePort({ group: async () => [slack, other] });

    const groups = await chatsOver(port).group({ platform: "slack", name: "x" });

    expect(groups.map((chat) => chat.ref)).toEqual([slack, other]);
  });

  it("sends into the thread that hangs off a sent message", async () => {
    const { port, sends } = fakePort();
    const chat = chatsOver(port).byRef(slack);

    const first = await chat.send({ text: "Status?" });
    const thread = chat.thread(first.message);
    await thread.send({ text: "Second line." });

    expect(thread.ref).toEqual({ chat: slack, id: first.message.id });
    expect(sends[1]?.place).toEqual({ chat: slack, id: first.message.id });
  });

  it("refuses a thread at a message of another chat, before any send", () => {
    const { port, sends } = fakePort();
    const chat = chatsOver(port).byRef(slack);

    const elsewhere = { chat: { platform: "slack", id: 9 }, id: 1 };
    expect(() => chat.thread(elsewhere)).toThrow();
    expect(sends).toEqual([]);
  });

  it("passes a port's refusal through unchanged", async () => {
    const refusal = new SendError("sender_ambiguous", "Name the account to send as");
    const { port } = fakePort({
      send: async () => {
        throw refusal;
      },
    });

    await expect(chatsOver(port).send(slack, { text: "x" })).rejects.toBe(refusal);
  });
});

describe("isSendError", () => {
  it("holds for an error rebuilt by name and code across a process boundary", () => {
    const rebuilt = Object.assign(new Error("no direct message"), {
      name: "SendError",
      code: "no_dm",
    });
    expect(isSendError(rebuilt)).toBe(true);
  });

  it("does not hold for an unknown code or another error", () => {
    const unknown = Object.assign(new Error("x"), { name: "SendError", code: "nope" });
    expect(isSendError(unknown)).toBe(false);
    expect(isSendError(new Error("x"))).toBe(false);
  });
});

describe("places", () => {
  it("tells a thread from a chat", () => {
    const thread = { chat: slack, id: 4 };
    expect(isThreadRef(thread)).toBe(true);
    expect(isThreadRef(slack)).toBe(false);
    expect(chatOf(thread)).toEqual(slack);
    expect(chatOf(slack)).toEqual(slack);
  });
});
