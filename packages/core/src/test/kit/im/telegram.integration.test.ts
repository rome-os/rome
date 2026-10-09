import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import type { TelegramAdapter } from "../../../channels/telegram.js";
import { comparable, loadCapture } from "./capture.js";
import textCapture from "./captures/telegram-text.capture.json" with { type: "json" };
import { deferred } from "./peer.js";
import { TELEGRAM_CHAT, TELEGRAM_TOKEN, TelegramPeer } from "./telegram.js";

const capture = loadCapture(textCapture);
const chat = String(TELEGRAM_CHAT) as ConversationId;

describe("TelegramPeer", () => {
  it("answers the recorded requests the way Telegram did", async () => {
    const peer = await TelegramPeer.start();
    const bot = peer.createBot(TELEGRAM_TOKEN);
    try {
      for (const { label, request, response } of capture.exchanges) {
        const method = request.path.slice(request.path.lastIndexOf("/") + 1);
        const call = bot.api.raw[method as "sendMessage"](request.body as never);
        // grammy resolves only what Telegram accepted.
        if (response.status === undefined || response.status < 400) await call;
        else await expect(call).rejects.toMatchObject({ error_code: response.status });
        const answered = peer.server.exchanges.at(-1)?.response ?? { body: undefined };
        expect({ label, ...comparable(capture, answered, response) }).toEqual({
          label,
          ...comparable(capture, response, response),
        });
      }
      expect(peer.server.exchanges.map((exchange) => exchange.source)).toEqual(
        capture.exchanges.map(() => "capture"),
      );
      peer.server.assertClean();
    } finally {
      await peer.close();
    }
  });
  it("parses HTML as Telegram does, and refuses what Telegram cannot parse", async () => {
    const peer = await TelegramPeer.start();
    const send = (text: string) =>
      peer.createBot(TELEGRAM_TOKEN).api.sendMessage(TELEGRAM_CHAT, text, { parse_mode: "HTML" });
    try {
      await expect(send("<b>hi</b> &amp; 😀")).resolves.toMatchObject({ text: "hi & 😀" });
      // Only `<` starts markup: a stray `&` or `>` is literal text.
      await expect(send("AT&T, 1 > 0")).resolves.toMatchObject({ text: "AT&T, 1 > 0" });
      await expect(send('<span class="tg-spoiler">x</span>')).resolves.toMatchObject({ text: "x" });
      for (const bad of ["<b>unclosed", "<div>x</div>", "<b><i>x</b></i>", "<span>x</span>"])
        await expect(send(bad)).rejects.toMatchObject({
          description: "Bad Request: can't parse entities",
        });
      // An emoji is two UTF-16 units, so 2049 of them exceed 4096.
      await expect(send(`<b>${"😀".repeat(2049)}</b>`)).rejects.toMatchObject({
        description: "Bad Request: message is too long",
      });
    } finally {
      await peer.close();
    }
  });
});

describe("TelegramAdapter.send against the peer", () => {
  let peer: TelegramPeer;
  let adapter: TelegramAdapter;

  beforeEach(async () => {
    peer = await TelegramPeer.start();
    adapter = peer.createAdapter();
    await adapter.start();
    await peer.untilPolling();
  });

  afterEach(async () => {
    await adapter.stop();
    await peer.close();
    // Every test, teardown included, made only requests the peer models.
    peer.server.assertClean();
  });

  async function receive(text: string): Promise<ChannelMessage> {
    const heard = deferred<ChannelMessage>();
    adapter.onInbound(async (message) => heard.resolve(message));
    peer.emitMessage(text);
    return heard.promise;
  }

  it("replies to the user's message and reports the new message's id", async () => {
    const inbound = await receive("hello");

    const receipt = await adapter.send(chat, {
      text: "**hi** there",
      replyToMessageId: inbound.messageId,
    });

    expect(peer.visible()).toEqual([
      expect.objectContaining({ from: "user", text: "hello" }),
      expect.objectContaining({
        id: receipt.messageId,
        from: "rome",
        text: "hi there",
        replyTo: inbound.messageId,
      }),
    ]);
    peer.server.assertClean();
  });

  it("rejects a reply to a message Telegram does not have, after retrying it as plain text", async () => {
    await expect(adapter.send(chat, { text: "hi", replyToMessageId: "999" })).rejects.toMatchObject(
      {
        description: "Bad Request: message to be replied not found",
      },
    );

    // The adapter treats every refusal of the HTML send as a formatting
    // problem and sends again. Telegram refuses both, so nothing is shown.
    const sends = peer.server.exchanges.filter((e) => e.request.path.endsWith("/sendMessage"));
    expect(sends.map((e) => e.request.body.parse_mode)).toEqual(["HTML", undefined]);
    expect(peer.visible().filter((m) => m.from === "rome")).toEqual([]);
  });

  it("rejects a reply to a message in another chat", async () => {
    const elsewhere = peer.emitMessage("hello", 456);

    await expect(
      adapter.send(chat, { text: "hi", replyToMessageId: elsewhere.id }),
    ).rejects.toThrow("message to be replied not found");
  });

  it("fails a text over Telegram's 4096-character limit instead of splitting it", async () => {
    await expect(adapter.send(chat, { text: "a".repeat(4097) })).rejects.toThrow(
      "message is too long",
    );
    expect(peer.visible()).toEqual([]);
  });
});
