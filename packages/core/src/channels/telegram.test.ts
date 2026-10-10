import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { InputFile } from "grammy";
import { TelegramAdapter } from "./telegram.js";
import { FakeTelegramApi } from "../test/kit/fake-telegram.js";
import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import type { OutgoingMessage } from "./types.js";

// The Telegram Bot API server is the process edge here, played by
// FakeTelegramApi through the adapter's createBot seam: grammy itself runs
// for real (filter middleware, init, long-poll lifecycle, InputFile), and the
// fake answers outbound API calls at the wire layer. Assertions read raw
// { method, payload } pairs — the actual outbound HTTP contract. Profile
// paths resolve through HOME/ROME_PROFILE env scoping (no module mocks), and
// the file-download fetch is a stubbed global until the kit grows
// fetchRecorder (PR 7 on #763).

describe("TelegramAdapter", () => {
  let adapter: TelegramAdapter;
  let telegram: FakeTelegramApi;
  let sandboxHome: string;

  beforeEach(async () => {
    rs.unstubAllGlobals();
    sandboxHome = await mkdtemp(join(tmpdir(), "rome-telegram-"));
    rs.stubEnv("HOME", sandboxHome);
    rs.stubEnv("ROME_PROFILE", "telegram-test");
    telegram = new FakeTelegramApi();
    adapter = new TelegramAdapter({ botToken: "test-token" }, telegram.createBot);
  });

  afterEach(async () => {
    await adapter.stop().catch(() => {});
    rs.unstubAllEnvs();
    await rm(sandboxHome, { recursive: true, force: true });
  });

  const CHAT = "chat-99" as ConversationId;

  /** A Telegram `message` update, in real Bot API wire shape. */
  function makeUpdate(overrides: Record<string, unknown> = {}) {
    return {
      message: {
        message_id: 42,
        date: 1700000000,
        text: "hello",
        from: {
          id: 111,
          is_bot: false,
          first_name: "Alice",
          last_name: "Smith",
          ...((overrides.from as Record<string, unknown>) ?? {}),
        },
        chat: {
          id: 999,
          type: "private",
          ...((overrides.chat as Record<string, unknown>) ?? {}),
        },
        ...((overrides.message as Record<string, unknown>) ?? {}),
      },
    };
  }

  /** Start the adapter, wait for polling, and collect inbound messages. */
  async function startCapturing(): Promise<ChannelMessage[]> {
    const captured: ChannelMessage[] = [];
    adapter.onInbound(async (msg) => {
      captured.push(msg);
    });
    await adapter.start();
    await telegram.untilPolling();
    return captured;
  }

  describe("inbound messages", () => {
    it("emits a private message as the channel's record, with the Bot API message as raw", async () => {
      const captured = await startCapturing();
      const update = makeUpdate({ from: { username: "alice_smith" } });

      await telegram.emitUpdate(update);

      expect(captured).toEqual([
        {
          channel: "telegram",
          direction: "inbound",
          messageId: "42",
          conversationId: "999",
          senderId: "111",
          senderDisplayName: "Alice Smith",
          senderUsername: "alice_smith",
          text: "hello",
          attachments: [],
          timestamp: new Date(1700000000 * 1000),
          thread: { kind: "dm" },
          addressing: "direct",
          raw: update.message,
        },
      ]);
      expect(captured[0]).not.toHaveProperty("replyTo");
    });

    it("recognizes commands addressed to this bot in groups", async () => {
      const captured = await startCapturing();
      for (const text of ["/start@FAKE_BOT", "/start@other_bot", "/start"]) {
        await telegram.emitUpdate(
          makeUpdate({
            chat: { id: -555, type: "group" },
            message: { text, entities: [{ type: "bot_command", offset: 0, length: text.length }] },
          }),
        );
      }
      expect(captured.map((message) => message.addressing)).toEqual([
        "mention",
        "ambient",
        "ambient",
      ]);
    });

    it("distinguishes ambient groups, bot mentions, replies and anonymous channel senders", async () => {
      const captured = await startCapturing();
      await telegram.emitUpdate(makeUpdate({ chat: { id: -555, type: "group" } }));
      await telegram.emitUpdate(
        makeUpdate({
          chat: { id: -555, type: "group" },
          message: {
            text: "@FAKE_BOT hello",
            entities: [{ type: "mention", offset: 0, length: 9 }],
          },
        }),
      );
      await telegram.emitUpdate(
        makeUpdate({
          chat: { id: -555, type: "group" },
          message: {
            reply_to_message: {
              message_id: 1,
              date: 1700000000,
              chat: { id: -555, type: "group" },
              from: { id: 424242, is_bot: true, first_name: "bot" },
            },
          },
        }),
      );
      await telegram.emitUpdate(
        makeUpdate({
          chat: { id: -555, type: "group" },
          message: {
            sender_chat: { id: -555, type: "group", title: "Anonymous" },
          },
        }),
      );
      expect(captured.map((msg) => msg.addressing)).toEqual([
        "ambient",
        "mention",
        "reply",
        "ambient",
      ]);
      expect(captured[3].senderId).toBe("-555");
    });

    it("names a group conversation's thread", async () => {
      const captured = await startCapturing();

      await telegram.emitUpdate(
        makeUpdate({ chat: { id: 555, type: "group", title: "My Group" } }),
      );

      expect(captured[0].thread).toEqual({ kind: "group", name: "My Group" });
      expect(captured[0].conversationId).toBe("555");
    });

    it("extracts photo attachments (uses largest)", async () => {
      const captured = await startCapturing();

      await telegram.emitUpdate(
        makeUpdate({
          message: {
            text: undefined,
            caption: "nice pic",
            photo: [
              { file_id: "small", width: 100, height: 100 },
              { file_id: "large", width: 800, height: 600 },
            ],
          },
        }),
      );

      expect(captured[0].attachments).toEqual([
        { type: "image", url: "large", caption: "nice pic" },
      ]);
    });

    it("extracts document attachments", async () => {
      const captured = await startCapturing();

      await telegram.emitUpdate(
        makeUpdate({
          message: {
            text: undefined,
            caption: "my doc",
            document: {
              file_id: "doc-123",
              mime_type: "application/pdf",
              file_name: "report.pdf",
            },
          },
        }),
      );

      expect(captured[0].attachments).toEqual([
        {
          type: "document",
          url: "doc-123",
          mimeType: "application/pdf",
          fileName: "report.pdf",
          caption: "my doc",
        },
      ]);
    });

    it("uses caption as text when no text present", async () => {
      const captured = await startCapturing();

      await telegram.emitUpdate(
        makeUpdate({
          message: {
            text: undefined,
            caption: "caption text",
            photo: [{ file_id: "img", width: 100, height: 100 }],
          },
        }),
      );

      expect(captured[0].text).toBe("caption text");
    });

    it("extracts the reply reference", async () => {
      const captured = await startCapturing();

      await telegram.emitUpdate(
        makeUpdate({
          message: {
            message_id: 10,
            text: "replying",
            reply_to_message: {
              message_id: 5,
              date: 1700000000,
              chat: { id: 999, type: "private" },
            },
          },
        }),
      );

      expect(captured[0].replyTo).toEqual({ messageId: "5" });
    });

    it("emits a channel post as the channel speaking", async () => {
      const captured = await startCapturing();

      // A channel post is a channel identity even when an author is supplied.
      await telegram.emitUpdate({
        channel_post: {
          message_id: 77,
          from: { id: 111, is_bot: false, first_name: "Alice" },
          date: 1700000000,
          text: "channel announcement",
          chat: { id: -1001234, type: "channel", title: "My Channel" },
        },
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].messageId).toBe("77");
      expect(captured[0].channel).toBe("telegram");
      expect(captured[0].senderId).toBe("-1001234");
      expect(captured[0].senderDisplayName).toBe("My Channel");
      expect(captured[0]).not.toHaveProperty("senderUsername");
      expect(captured[0].conversationId).toBe("-1001234");
      expect(captured[0].thread).toEqual({ kind: "group", name: "My Channel" });
      expect(captured[0].text).toBe("channel announcement");
    });

    it("ignores update types the adapter did not subscribe to", async () => {
      const captured = await startCapturing();

      // grammy's real filter middleware drops e.g. edited_message updates
      await telegram.emitUpdate({
        edited_message: {
          message_id: 43,
          date: 1700000001,
          text: "edited!",
          from: { id: 111, is_bot: false, first_name: "Alice" },
          chat: { id: 999, type: "private" },
        },
      });

      expect(captured).toEqual([]);
    });
  });

  describe("send()", () => {
    it("sends a text message with HTML parse mode", async () => {
      const outgoing: OutgoingMessage = { text: "hi there" };
      const receipt = await adapter.send(CHAT, outgoing);

      expect(receipt).toEqual({ conversationId: CHAT, messageId: expect.any(String) });
      expect(telegram.sent).toEqual([
        {
          method: "sendMessage",
          payload: { chat_id: "chat-99", text: "hi there", parse_mode: "HTML" },
        },
      ]);
    });

    it("converts markdown bold/italic to HTML", async () => {
      const outgoing: OutgoingMessage = { text: "**bold** and *italic*" };
      await adapter.send(CHAT, outgoing);

      expect(telegram.sent).toEqual([
        {
          method: "sendMessage",
          payload: {
            chat_id: "chat-99",
            text: "<b>bold</b> and <i>italic</i>",
            parse_mode: "HTML",
          },
        },
      ]);
    });

    it("converts code blocks to <pre>", async () => {
      const outgoing: OutgoingMessage = { text: "```js\nconsole.log(1)\n```" };
      await adapter.send(CHAT, outgoing);

      expect(telegram.sent).toHaveLength(1);
      const text = telegram.sent[0].payload.text as string;
      expect(telegram.sent[0].method).toBe("sendMessage");
      expect(text).toContain("<pre>");
      expect(text).toContain("console.log(1)");
    });

    it("converts headers to bold text", async () => {
      const outgoing: OutgoingMessage = { text: "## My Header\nsome text" };
      await adapter.send(CHAT, outgoing);

      expect(telegram.sent).toHaveLength(1);
      const text = telegram.sent[0].payload.text as string;
      expect(telegram.sent[0].method).toBe("sendMessage");
      expect(text).toContain("<b>My Header</b>");
      expect(text).not.toContain("##");
    });

    it("falls back to plain text when HTML parsing fails", async () => {
      telegram.failNextSend("Bad Request: can't parse entities");

      const outgoing: OutgoingMessage = { text: "broken <markup" };
      await adapter.send(CHAT, outgoing);

      // Telegram rejected the HTML attempt, then accepted the plain-text retry
      expect(telegram.sent).toHaveLength(2);
      expect(telegram.sent[0].method).toBe("sendMessage");
      expect(telegram.sent[0].payload.parse_mode).toBe("HTML");
      expect(telegram.sent[1]).toEqual({
        method: "sendMessage",
        payload: { chat_id: "chat-99", text: "broken <markup" },
      });
    });

    it("sends attachments via appropriate API methods", async () => {
      const outgoing: OutgoingMessage = {
        attachments: [
          { type: "image", source: "https://example.com/pic.png", caption: "pic" },
          { type: "document", source: "/tmp/file.pdf" },
        ],
      };
      await adapter.send(CHAT, outgoing);

      expect(telegram.sent).toHaveLength(2);
      expect(telegram.sent[0]).toEqual({
        method: "sendPhoto",
        payload: { chat_id: "chat-99", photo: "https://example.com/pic.png", caption: "pic" },
      });
      // Local files are wrapped in grammy's InputFile for multipart upload
      expect(telegram.sent[1].method).toBe("sendDocument");
      expect(telegram.sent[1].payload.chat_id).toBe("chat-99");
      const document = telegram.sent[1].payload.document;
      expect(document).toBeInstanceOf(InputFile);
      expect((document as InputFile).filename).toBe("file.pdf");
    });
  });

  describe("saveIncomingAttachments()", () => {
    it("downloads Telegram bot attachments through the size-limited reader", async () => {
      const body = Buffer.from("image-data");
      telegram.addFile("file-id", "photos/photo.jpg");
      rs.stubGlobal(
        "fetch",
        rs.fn(async () => {
          return new Response(body, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        }),
      );

      const attachments = await adapter.saveIncomingAttachments({
        channel: "telegram",
        direction: "inbound",
        messageId: "42",
        conversationId: "999" as ConversationId,
        senderId: "111",
        timestamp: new Date("2026-05-10T00:00:00Z"),
        text: "",
        attachments: [{ type: "image", url: "file-id" }],
      });

      expect(fetch).toHaveBeenCalledWith(
        "https://api.telegram.org/file/bottest-token/photos/photo.jpg",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(attachments[0].localPath).toBeTruthy();
      // Persisted inside the env-scoped profile sandbox, not the real HOME
      expect(attachments[0].localPath).toContain(sandboxHome);
      // Saved under the same channel/conversation/message path as before.
      expect(attachments[0].localPath).toContain(
        join("channel-attachments", "telegram", "999", "42"),
      );
      expect(attachments[0].mimeType).toBe("image/jpeg");
      await expect(readFile(attachments[0].localPath!)).resolves.toEqual(body);
    });
  });

  describe("lifecycle", () => {
    it("start() begins a long poll, stop() ends it", async () => {
      await adapter.start();
      await telegram.untilPolling();
      expect(telegram.tokens).toEqual(["test-token"]);
      expect(telegram.polling).toBe(true);

      await adapter.stop();
      expect(telegram.polling).toBe(false);
      // A stopped transport no longer delivers, matching the real polling loop
      await expect(telegram.emitUpdate(makeUpdate())).rejects.toThrow(/not polling/);
    });

    it("does not deliver updates before start()", async () => {
      adapter.onInbound(async () => {});
      await expect(telegram.emitUpdate(makeUpdate())).rejects.toThrow(/not polling/);
    });

    it("fails loudly on Bot API methods the fake does not model", async () => {
      // Guards against silent drift: a future adapter API call must be taught
      // to the fake before its tests can pass.
      const bot = new FakeTelegramApi().createBot("drift-token");
      await expect(bot.api.raw.banChatMember({ chat_id: 1, user_id: 2 })).rejects.toThrow(
        /unmodeled Bot API method "banChatMember"/,
      );
    });
  });
});
