import { LarkApiFixture, LARK_CHAT } from "./lark.js";
import { describe, expect, it } from "@rstest/core";
import { DiscordApiFixture, DISCORD_DM, DISCORD_USER } from "./discord.js";
import { deferred } from "./server.js";
import type { NormalizedMessage } from "../../../channels/types.js";
import { TelegramApiFixture } from "./telegram.js";
import { WechatApiFixture, WECHAT_USER } from "./wechat.js";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("IM delivery adapters through local protocol peers", () => {
  it("keeps Feishu API refusal and unknown acceptance distinct without SDK retries", async () => {
    const fixture = await new LarkApiFixture().start();
    const adapter = fixture.createAdapter();
    const path = "/open-apis/im/v1/messages";
    try {
      await adapter.start();
      const receipt = await adapter.createText(LARK_CHAT, "preview");
      await adapter.updateText(LARK_CHAT, receipt.messageId, "final");
      expect(JSON.parse(fixture.messages.get(receipt.messageId)!.body.content)).toEqual({
        text: "final",
      });
      for (const [code, kind] of [
        [230011, "failed"],
        [230020, "rate-limit"],
        [99991663, "authorization"],
      ] as const) {
        fixture.server.once({
          method: "PUT",
          path: `${path}/${receipt.messageId}`,
          response: { body: { code, msg: "fixture refusal" } },
        });
        await expect(
          adapter.updateText(LARK_CHAT, receipt.messageId, "rejected"),
        ).rejects.toMatchObject({ kind });
      }
      fixture.server.once({
        method: "PUT",
        path: `${path}/${receipt.messageId}`,
        response: { status: 429, headers: { "retry-after": "2" }, body: { code: 99991400 } },
      });
      await expect(
        adapter.updateText(LARK_CHAT, receipt.messageId, "limited"),
      ).rejects.toMatchObject({
        kind: "rate-limit",
        retryAfterMs: 2000,
      });
      fixture.server.once({
        method: "POST",
        path,
        response: { body: { code: 230011, msg: "fixture refusal" } },
      });
      await expect(adapter.createText(LARK_CHAT, "rejected")).rejects.toMatchObject({
        kind: "failed",
      });
      expect(fixture.messages.size).toBe(1);
      fixture.server.once({ method: "POST", path, dropAfterAccept: true });
      await expect(
        adapter.createText(LARK_CHAT, "accepted but disconnected"),
      ).rejects.toMatchObject({ kind: "unknown" });
      expect(fixture.messages.size).toBe(2);
      expect(
        fixture.server.calls.filter((call) => call.method === "POST" && call.path === path),
      ).toHaveLength(3);
      fixture.server.assertClean();
    } finally {
      await adapter.stop();
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
      const receipt = await adapter.createText("123", "preview");
      await adapter.updateText("123", receipt.messageId, "final");
      expect(fixture.messages.get(Number(receipt.messageId))?.text).toBe("final");
      const sent = await adapter.sendMessage("123", "123", {
        attachments: [{ type: "document", source: file }],
      });
      expect(sent.parts).toHaveLength(1);
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

  it("runs WeChat polling, context-bound sends, encrypted upload and structured API failures", async () => {
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
      expect(await adapter.createText(WECHAT_USER, "reply")).toBeUndefined();
      await adapter.sendMessage(WECHAT_USER, WECHAT_USER, {
        attachments: [{ type: "document", source: file }],
      });
      expect(fixture.messages).toHaveLength(2);
      expect(fixture.uploads).toHaveLength(1);
      expect(Buffer.from(fixture.uploads[0]).toString()).not.toContain("fixture file");
      fixture.server.once({
        method: "POST",
        path: "/ilink/bot/sendmessage",
        response: { body: { ret: -1, errmsg: "blocked" } },
      });
      await expect(adapter.createText(WECHAT_USER, "rejected")).rejects.toMatchObject({
        kind: "failed",
      });
      fixture.server.once({
        method: "POST",
        path: "/ilink/bot/sendmessage",
        response: { status: 429, headers: { "retry-after": "2" } },
      });
      await expect(adapter.createText(WECHAT_USER, "limited")).rejects.toMatchObject({
        kind: "rate-limit",
        retryAfterMs: 2000,
      });
      expect(fixture.messages).toHaveLength(2);
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
      const receipt = await adapter.createText(DISCORD_DM, "First");
      await adapter.updateText(DISCORD_DM, receipt.messageId, "Final 中文 👋");
      expect(fixture.messages.get(receipt.messageId)?.content).toBe("Final 中文 👋");
      expect(
        fixture.server.calls.filter((call) => call.path.endsWith(`/messages/${receipt.messageId}`)),
      ).toHaveLength(1);
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
    const adapter = fixture.createAdapter();
    const path = `/api/v10/channels/${DISCORD_DM}/messages`;
    try {
      await adapter.start();
      fixture.server.once({
        method: "POST",
        path,
        response: {
          status: 429,
          body: { message: "Rate limited", retry_after: 0.02, global },
          headers: { "retry-after": "0.02", "x-ratelimit-bucket": "fixture" },
        },
      });
      const receipt = await adapter.createText(DISCORD_DM, "after limit");
      expect(fixture.messages.get(receipt.messageId)?.content).toBe("after limit");
      const calls = fixture.server.calls.filter(
        (call) => call.method === "POST" && call.path === path,
      );
      expect(calls).toHaveLength(2);
      expect(calls[1].startedAt - calls[0].completedAt!).toBeGreaterThanOrEqual(18);
      fixture.server.once({ method: "POST", path, dropAfterAccept: true });
      await expect(
        adapter.createText(DISCORD_DM, "accepted without response"),
      ).rejects.toMatchObject({ kind: "unknown" });
      expect(
        [...fixture.messages.values()].filter(
          (message) => message.content === "accepted without response",
        ),
      ).toHaveLength(1);
      fixture.server.assertClean();
    } finally {
      await adapter.stop();
      await fixture.close();
    }
  });
});
