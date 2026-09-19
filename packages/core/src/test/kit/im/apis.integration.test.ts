import { Routes } from "discord.js";
import { describe, expect, it } from "@rstest/core";
import { DiscordApiFixture, DISCORD_DM, DISCORD_USER, DISCORD_TOKEN } from "./discord.js";
import { LarkApiFixture, LARK_CHAT, LARK_USER } from "./lark.js";
import { deferred, requestBarrier } from "./server.js";
import type { NormalizedMessage } from "../../../channels/types.js";
import { TelegramApiFixture, TELEGRAM_TOKEN } from "./telegram.js";
import { WechatApiFixture, WECHAT_USER } from "./wechat.js";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("IM protocol fixtures with real SDKs", () => {
  it("deduplicates raw Lark events in the real SDK and preserves message identity across reply/read/edit", async () => {
    const fixture = await new LarkApiFixture().start();
    const channel = fixture.createChannel();
    const received: string[] = [];
    const delivered = deferred();
    channel.on("message", async (message) => {
      received.push(message.content);
      delivered.resolve();
    });
    try {
      await channel.connect();
      await Promise.all([
        fixture.emitMessage("once", "duplicate"),
        fixture.emitMessage("once", "duplicate"),
      ]);
      expect(fixture.acknowledged).toHaveLength(2);
      expect(new Set(fixture.acknowledged).size).toBe(2);
      await delivered.promise;
      expect(received).toEqual(["once"]);
      const reply = await channel.send(LARK_CHAT, { text: "reply" }, { replyTo: "om_duplicate" });
      const result = await channel.rawClient.im.message.get({
        path: { message_id: reply.messageId },
      });
      expect(result.data?.items?.[0].body?.content).toContain("reply");
      for (const text of ["c", "correct", "corrected"]) {
        await channel.rawClient.im.message.update({
          path: { message_id: reply.messageId },
          data: { msg_type: "text", content: JSON.stringify({ text }) },
        });
        const current = await channel.rawClient.im.message.get({
          path: { message_id: reply.messageId },
        });
        expect(current.data?.items?.[0]).toMatchObject({
          message_id: reply.messageId,
          body: { content: JSON.stringify({ text }) },
        });
        expect(fixture.messages.get(reply.messageId)?.body.content).toBe(JSON.stringify({ text }));
      }
      expect(fixture.messages.size).toBe(2);
      fixture.server.assertClean();
    } finally {
      await channel.disconnect();
      await fixture.close();
    }
  });

  it("runs Telegram long polling, editing and real multipart file serialization", async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), "rome-im-"));
    const file = join(directory.path, "hello.txt");
    await writeFile(file, "fixture file 中文");
    const fixture = await new TelegramApiFixture().start();
    const adapter = fixture.createAdapter();
    const received = deferred<NormalizedMessage>();
    adapter.onMessage(async (message) => received.resolve(message));
    try {
      await adapter.start();
      await fixture.untilPolling();
      fixture.emitMessage("Hello Telegram");
      expect(await received.promise).toMatchObject({ text: "Hello Telegram" });
      const bot = fixture.createBot(TELEGRAM_TOKEN);
      const receipt = await bot.api.sendMessage("123", "preview");
      for (const text of ["f", "fin", "final"]) {
        const edited = await bot.api.editMessageText("123", receipt.message_id, text);
        expect(edited).toMatchObject({ message_id: receipt.message_id, text });
        expect(fixture.messages.get(receipt.message_id)?.text).toBe(text);
      }
      for (const text of ["x", "x".repeat(4096)]) {
        await bot.api.editMessageText("123", receipt.message_id, text);
        expect(fixture.messages.get(receipt.message_id)?.text).toBe(text);
      }
      for (const text of ["", "x".repeat(4097)]) {
        await expect(
          bot.api.editMessageText("123", receipt.message_id, text),
        ).rejects.toMatchObject({
          error_code: 400,
        });
        expect(fixture.messages.get(receipt.message_id)?.text).toBe("x".repeat(4096));
      }
      expect(fixture.messages.size).toBe(1);
      await adapter.sendMessage("123", "123", {
        attachments: [{ type: "document", source: file }],
      });
      expect(
        fixture.server.calls.find((call) => call.path.endsWith("/sendDocument"))?.files,
      ).toEqual([
        expect.objectContaining({
          name: "hello.txt",
          size: Buffer.byteLength("fixture file 中文"),
        }),
      ]);
      fixture.server.assertClean();
    } finally {
      await adapter.stop();
      await fixture.close();
    }
  });

  it("runs WeChat polling, context-bound sends, encrypted upload", async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), "rome-im-"));
    const file = join(directory.path, "hello.txt");
    await writeFile(file, "fixture file 中文");
    const fixture = await new WechatApiFixture().start();
    const adapter = fixture.createAdapter(directory.path);
    const received = deferred<NormalizedMessage>();
    adapter.onMessage(async (message) => received.resolve(message));
    try {
      await adapter.start();
      await fixture.untilPolling();
      fixture.emitMessage("Hello WeChat");
      expect(await received.promise).toMatchObject({ text: "Hello WeChat" });
      await adapter.notifyTyping(WECHAT_USER);
      await adapter.sendMessage(WECHAT_USER, WECHAT_USER, { text: "reply" });
      await adapter.sendMessage(WECHAT_USER, WECHAT_USER, {
        attachments: [{ type: "document", source: file }],
      });
      expect(fixture.messages).toHaveLength(2);
      expect(fixture.uploads).toHaveLength(1);
      expect(Buffer.from(fixture.uploads[0]).toString()).not.toContain("fixture file");
      fixture.server.assertClean();
    } finally {
      await adapter.stop();
      await fixture.close();
    }
  });
  it("runs Discord gateway input, DM creation, message creation and editing through real discord.js", async () => {
    const fixture = await new DiscordApiFixture().start();
    const adapter = fixture.createAdapter();
    const received = deferred<NormalizedMessage>();
    adapter.onMessage(async (message) => received.resolve(message));
    try {
      await adapter.start();
      expect(await adapter.directConversationFor(DISCORD_USER)).toBe(DISCORD_DM);
      fixture.emitMessage("你好 👋");
      expect(await received.promise).toMatchObject({
        text: "你好 👋",
        channelUserId: DISCORD_USER,
      });
      const receipt = await adapter.sendMessage(DISCORD_USER, DISCORD_DM, { text: "First" });
      const rest = fixture.transport().createRest!({ version: "10" }).setToken(DISCORD_TOKEN);
      for (const content of ["F", "Final 中文", "Final 中文 👋"]) {
        await rest.patch(Routes.channelMessage(DISCORD_DM, receipt.messageId!), {
          body: { content },
        });
        expect(await rest.get(Routes.channelMessage(DISCORD_DM, receipt.messageId!))).toMatchObject(
          {
            id: receipt.messageId,
            content,
          },
        );
        expect(fixture.messages.get(receipt.messageId!)?.content).toBe(content);
      }
      expect(fixture.messages.size).toBe(2);
      expect(
        fixture.server.calls.filter((call) => call.path.endsWith(`/messages/${receipt.messageId}`)),
      ).toHaveLength(6);
      fixture.server.assertClean();
    } finally {
      await adapter.stop();
      await fixture.close();
    }
  });

  it.each([
    false,
    true,
  ])("honors Discord 429 (global=%s) and distinguishes an accepted request whose response was lost", async (global) => {
    const fixture = await new DiscordApiFixture().start();
    const rest = fixture.transport().createRest!({ version: "10", retries: 0 }).setToken(
      DISCORD_TOKEN,
    );
    const path = `/api/v10/channels/${DISCORD_DM}/messages`;
    try {
      fixture.server.once({
        method: "POST",
        path,
        response: {
          status: 429,
          body: { message: "Rate limited", retry_after: 0.02, global },
          headers: { "retry-after": "0.02", "x-ratelimit-bucket": "fixture" },
        },
      });
      const receipt = (await rest.post(Routes.channelMessages(DISCORD_DM), {
        body: { content: "after limit" },
      })) as { id: string };
      expect(fixture.messages.get(receipt.id)?.content).toBe("after limit");
      const calls = fixture.server.calls.filter(
        (call) => call.method === "POST" && call.path === path,
      );
      expect(calls).toHaveLength(2);
      expect(calls[1].startedAt - calls[0].completedAt!).toBeGreaterThanOrEqual(18);
      fixture.server.once({ method: "POST", path, dropAfterAccept: true });
      await expect(
        rest.post(Routes.channelMessages(DISCORD_DM), {
          body: { content: "accepted without response" },
        }),
      ).rejects.toThrow();
      expect(
        [...fixture.messages.values()].filter(
          (message) => message.content === "accepted without response",
        ),
      ).toHaveLength(1);
      fixture.server.assertClean();
    } finally {
      await fixture.close();
    }
  });

  it("holds an initial Discord create until explicitly released", async () => {
    const fixture = await new DiscordApiFixture().start();
    const adapter = fixture.createAdapter();
    const barrier = requestBarrier();
    try {
      await adapter.start();
      fixture.server.once({
        method: "POST",
        path: `/api/v10/channels/${DISCORD_DM}/messages`,
        before: barrier.wait,
      });
      const pending = adapter.sendMessage(DISCORD_USER, DISCORD_DM, { text: "delayed" });
      await barrier.entered;
      expect(fixture.messages.size).toBe(0);
      barrier.release();
      await pending;
      expect(fixture.messages.size).toBe(1);
      fixture.server.assertClean();
    } finally {
      barrier.release();
      await adapter.stop();
      await fixture.close();
    }
  });

  it.each([
    "lark",
    "feishu",
  ] as const)("runs %s auth, binary WebSocket input and outbound text through the official SDK", async (domain) => {
    const fixture = await new LarkApiFixture().start();
    const adapter = fixture.createAdapter({ domain });
    const received = deferred<NormalizedMessage>();
    adapter.onMessage(async (message) => received.resolve(message));
    try {
      await adapter.start();
      await fixture.emitMessage("你好 Lark", "event-1");
      expect(await received.promise).toMatchObject({ text: "你好 Lark", channelUserId: LARK_USER });
      const receipt = await adapter.sendMessage(LARK_USER, LARK_CHAT, { text: "Hello 👋" });
      expect(fixture.messages.get(receipt!.messageId!)?.body.content).toContain("Hello");
      const reaction = await adapter.addProcessingReaction(receipt!.messageId!);
      await adapter.removeProcessingReaction(receipt!.messageId!, reaction!);
      expect(fixture.acknowledged).toEqual([expect.stringMatching(/^event-1:/)]);
      expect(JSON.stringify(fixture.server.calls)).not.toContain(fixture.appSecret);
      fixture.server.assertClean();
    } finally {
      await adapter.stop();
      await fixture.close();
    }
  });
});
