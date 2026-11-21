import { createHmac } from "node:crypto";
import { describe, expect, it, rs } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import type { Message } from "../../message.js";
import { DiscordAppAdapter, type DiscordAppDeposit, isSignedBy, messageOf } from "./adapter.js";
import type { DiscordAppCloud } from "./worker.js";

const KEY = "a".repeat(64);
const BOT = "111111111111111111";
const GUARDIAN = "222222222222222222";

function deposit(over: Partial<DiscordAppDeposit> = {}): DiscordAppDeposit {
  return {
    id: "333333333333333333",
    channelId: "444444444444444444",
    serverName: "",
    channelName: "Direct message",
    author: { id: GUARDIAN, username: "ray", globalName: "Ray" },
    content: "hello",
    ts: "2026-11-20T10:00:00.000Z",
    ...over,
  };
}

function frame(body: unknown, key = KEY) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return { bytes, signature: createHmac("sha256", key).update(bytes).digest("hex") };
}

function adapter(sent: unknown[] = [], linked: string[] = []) {
  const cloud = {
    send: async (input: unknown) => {
      sent.push(input);
      return { id: `sent-${sent.length}` };
    },
  } as unknown as DiscordAppCloud;
  return new DiscordAppAdapter({
    botId: BOT,
    botUsername: "Rome",
    depositKey: KEY,
    cloud,
    linkGuardian: async (userId) => {
      linked.push(userId);
    },
  });
}

describe("Rome's Discord bot, as a frame from its Worker reaches it", () => {
  it("checks the Worker's signature over the exact body", () => {
    const { bytes, signature } = frame(deposit());
    expect(isSignedBy(bytes, signature, KEY)).toBe(true);
    expect(isSignedBy(bytes, signature, "b".repeat(64))).toBe(false);
    expect(isSignedBy(bytes, "zz", KEY)).toBe(false);
  });

  it("describes a direct message, a mention in a server and a thread as platform facts", () => {
    const direct = messageOf(deposit(), BOT, "Rome");
    expect(direct).toMatchObject({
      id: "333333333333333333",
      where: { chatId: "444444444444444444", kind: "direct" },
      sender: { accountId: GUARDIAN, name: "Ray", handle: "ray" },
      content: { text: "hello", attachments: [] },
      receivedBy: BOT,
      mentions: [],
    });
    expect(direct.where.name).toBeUndefined();

    const mention = messageOf(
      deposit({
        serverId: "555555555555555555",
        serverName: "Lab",
        channelName: "general",
        content: `<@${BOT}> find flights`,
        referencedMessageId: "666666666666666666",
      }),
      BOT,
      "Rome",
    );
    expect(mention).toMatchObject({
      where: { kind: "group", name: "general" },
      content: { text: "@Rome find flights" },
      mentions: [BOT],
      replyTo: { messageId: "666666666666666666" },
    });

    const thread = messageOf(
      deposit({ serverId: "5", parentId: "777777777777777777" }),
      BOT,
      "Rome",
    );
    expect(thread.where.thread).toEqual({ parentChatId: "777777777777777777" });
  });

  it("hands the message to Rome after putting its author under the guardian, and acknowledges it", async () => {
    const linked: string[] = [];
    const bot = adapter([], linked);
    const delivered: Message[] = [];
    bot.start((message) => {
      delivered.push(message);
    });
    const { bytes, signature } = frame(deposit());
    expect(await bot.ingest(bytes, signature)).toEqual({ status: 200 });
    expect(linked).toEqual([GUARDIAN]);
    expect(delivered.map((message) => message.id)).toEqual(["333333333333333333"]);
  });

  it("acknowledges every signed frame, also when Rome cannot take its message, and refuses an invalid one", async () => {
    const bot = adapter();
    const { bytes, signature } = frame(deposit());
    // Not started yet: the message is dropped with a log, never asked for again.
    expect(await bot.ingest(bytes, signature)).toEqual({ status: 200 });
    bot.start(() => {
      throw new Error("recording stopped");
    });
    expect(await bot.ingest(bytes, signature)).toEqual({ status: 200 });
    const failingLink = new DiscordAppAdapter({
      botId: BOT,
      botUsername: "Rome",
      depositKey: KEY,
      cloud: {} as DiscordAppCloud,
      linkGuardian: async () => {
        throw new Error("database is locked");
      },
    });
    const delivered: Message[] = [];
    failingLink.start((message) => delivered.push(message));
    expect(await failingLink.ingest(bytes, signature)).toEqual({ status: 200 });
    // The message still reaches Rome when its author could not be linked.
    expect(delivered).toHaveLength(1);
    // A frame the Worker did not sign, or that is no message, is refused.
    expect(await bot.ingest(bytes, "0".repeat(64))).toEqual({ status: 401 });
    const junk = frame({ hello: "world" });
    expect(await bot.ingest(junk.bytes, junk.signature)).toEqual({ status: 400 });
  });

  it("posts a long answer in parts of 2000 characters, the first replying to the message", async () => {
    const sent: Array<{ content: string; replyTo?: string }> = [];
    const bot = adapter(sent);
    const text = `${"a".repeat(1990)}\n${"b".repeat(100)}`;
    const receipt = await bot.send("444444444444444444" as ChatId, {
      text,
      replyToMessageId: "333333333333333333",
    });
    expect(sent.map((part) => part.content.length)).toEqual([1990, 100]);
    expect(sent[0]?.replyTo).toBe("333333333333333333");
    expect(sent[1]?.replyTo).toBeUndefined();
    expect(receipt).toEqual({ chatId: "444444444444444444", messageId: "sent-1" });
  });

  it("refuses a file, which the Worker cannot post", async () => {
    const send = rs.fn();
    const bot = new DiscordAppAdapter({
      botId: BOT,
      botUsername: "Rome",
      depositKey: KEY,
      cloud: { send } as unknown as DiscordAppCloud,
      linkGuardian: async () => {},
    });
    await expect(
      bot.send(
        "4" as ChatId,
        {
          text: "here",
          attachments: [{ type: "document", path: "/tmp/a.txt" }],
        } as never,
      ),
    ).rejects.toThrow("no attachments");
    expect(send).not.toHaveBeenCalled();
  });
});
