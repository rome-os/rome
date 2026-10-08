import { Bot, type Context, InputFile } from "grammy";
import { Marked, Renderer, type Token } from "marked";
import type { ChannelMessage, ConversationId, MessageReceipt } from "@rome-os/app-runtime";
import type { Attachment, OutgoingMessage, OutgoingAttachment } from "./types.js";
import {
  isAttachmentTooLargeError,
  readAttachmentResponseBody,
  saveIncomingAttachmentPayloads,
} from "./attachment-files.js";
import { createLogger } from "../logger.js";
import { basename } from "node:path";

const log = createLogger("telegram");

/**
 * Convert standard Markdown to Telegram-compatible HTML using `marked`.
 * Telegram supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <blockquote>.
 * Everything else is stripped/flattened to plain text.
 */
const telegramMarked = new Marked();

// Renderer methods that contain inline tokens must call this.parser.parseInline(tokens)
// to recursively render children (bold, italic, links, etc.). Using the raw `text`
// property would bypass inline parsing and output raw markdown.
const telegramRenderer: Partial<Renderer> = {
  // Block-level — these contain inline tokens that need recursive parsing
  heading(this: Renderer, { tokens }: { tokens: Token[] }) {
    return `<b>${this.parser.parseInline(tokens)}</b>\n`;
  },
  paragraph(this: Renderer, { tokens }: { tokens: Token[] }) {
    return `${this.parser.parseInline(tokens)}\n\n`;
  },
  blockquote(this: Renderer, { text }: { text: string }) {
    return `<blockquote>${text.trim()}</blockquote>\n`;
  },
  list(
    this: Renderer,
    { items }: { ordered: boolean; items: { tokens: Token[]; text: string }[] },
  ) {
    return items.map((item) => `- ${this.parser.parse(item.tokens).trim()}`).join("\n") + "\n\n";
  },
  listitem(this: Renderer, { tokens }: { tokens: Token[] }) {
    return this.parser.parseInline(tokens);
  },
  code({ text, lang }: { text: string; lang?: string }) {
    if (lang) {
      return `<pre><code class="language-${lang}">${escapeHtml(text)}</code></pre>\n`;
    }
    return `<pre>${escapeHtml(text)}</pre>\n`;
  },
  hr() {
    return "\n---\n";
  },

  // Inline — these also contain sub-tokens for nested formatting
  strong(this: Renderer, { tokens }: { tokens: Token[] }) {
    return `<b>${this.parser.parseInline(tokens)}</b>`;
  },
  em(this: Renderer, { tokens }: { tokens: Token[] }) {
    return `<i>${this.parser.parseInline(tokens)}</i>`;
  },
  del(this: Renderer, { tokens }: { tokens: Token[] }) {
    return `<s>${this.parser.parseInline(tokens)}</s>`;
  },
  codespan({ text }: { text: string }) {
    return `<code>${escapeHtml(text)}</code>`;
  },
  link(this: Renderer, { href, tokens }: { href: string; tokens: Token[] }) {
    return `<a href="${href}">${this.parser.parseInline(tokens)}</a>`;
  },
  image({ href, text }: { href: string; text: string }) {
    return `[${text}](${href})`;
  },
  br() {
    return "\n";
  },
};

telegramMarked.use({ renderer: telegramRenderer });

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markdownToTelegramHtml(md: string): string {
  const raw = telegramMarked.parse(md) as string;
  // marked wraps output in <p> tags and may add trailing whitespace; clean up
  return raw.replace(/<\/?p>/g, "").trim();
}

/**
 * The transport seam: tests inject a Bot wired to a fake Telegram Bot API
 * server via grammy's transformer API (see `test/kit/fake-telegram.ts`)
 * instead of module-mocking grammy.
 */
export type CreateTelegramBot = (botToken: string) => Bot;

/**
 * The Telegram Bot API transport. Inbound updates arrive as the channel's own
 * record, a `ChannelMessage` whose `raw` is the Bot API message, so the
 * Connection integration delivers them as they are.
 */
export class TelegramAdapter {
  private bot: Bot;
  private handler?: (msg: ChannelMessage) => Promise<void>;
  private onPollingError?: (err: unknown) => void;

  constructor(
    private config: { botToken: string; onPollingError?: (err: unknown) => void },
    createBot: CreateTelegramBot = (botToken) => new Bot(botToken),
  ) {
    this.bot = createBot(config.botToken);
    this.onPollingError = config.onPollingError;
  }

  async start(): Promise<void> {
    // Telegram sends "message" updates for private/group chats
    // and "channel_post" updates for broadcast channels.
    this.bot.on(["message", "channel_post"], async (ctx: Context) => {
      if (!this.handler) return;

      const rawMsg = ctx.message ?? ctx.channelPost;
      if (!rawMsg) return;

      const chat = ctx.chat!;
      const chatTitle = "title" in chat ? (chat as { title?: string }).title : undefined;
      // A channel post, or a message sent on behalf of a chat, speaks as the
      // chat rather than as a person.
      const fromPerson = ctx.from && !ctx.channelPost && !rawMsg.sender_chat ? ctx.from : undefined;

      const msg: ChannelMessage = {
        channel: "telegram",
        direction: "inbound",
        messageId: String(rawMsg.message_id),
        conversationId: String(chat.id) as ConversationId,
        senderId: ctx.channelPost
          ? String(chat.id)
          : rawMsg.sender_chat
            ? String(rawMsg.sender_chat.id)
            : ctx.from
              ? String(ctx.from.id)
              : String(chat.id),
        senderDisplayName: fromPerson
          ? [fromPerson.first_name, fromPerson.last_name].filter(Boolean).join(" ") || "Unknown"
          : (chatTitle ?? "Channel"),
        ...(fromPerson?.username ? { senderUsername: fromPerson.username } : {}),
        text: rawMsg.text ?? rawMsg.caption ?? "",
        attachments: this.extractAttachments(ctx),
        timestamp: new Date(rawMsg.date * 1000),
        ...(rawMsg.reply_to_message
          ? { replyTo: { messageId: String(rawMsg.reply_to_message.message_id) } }
          : {}),
        thread: {
          kind: chat.type === "private" ? "dm" : "group",
          ...(chatTitle ? { name: chatTitle } : {}),
        },
        addressing:
          chat.type === "private"
            ? "direct"
            : (rawMsg.entities ?? rawMsg.caption_entities ?? []).some((entity) => {
                  if (entity.type === "text_mention") return entity.user.id === ctx.me.id;
                  const text = (rawMsg.text ?? rawMsg.caption ?? "")
                    .slice(entity.offset, entity.offset + entity.length)
                    .toLowerCase();
                  const handle = `@${ctx.me.username.toLowerCase()}`;
                  return (
                    (entity.type === "mention" && text === handle) ||
                    (entity.type === "bot_command" && text.endsWith(handle))
                  );
                })
              ? "mention"
              : rawMsg.reply_to_message?.from?.id === ctx.me.id
                ? "reply"
                : "ambient",
        raw: rawMsg,
      };

      log.info("message received", {
        from: msg.senderId,
        conversationId: msg.conversationId,
        threadKind: msg.thread?.kind,
      });

      try {
        await this.handler!(msg);
      } catch (err) {
        log.error("message handler error", {
          messageId: msg.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // bot.init() validates the token (calls getMe). Await it so startup
    // fails fast on a bad token instead of silently dropping messages.
    await this.bot.init();

    // bot.start() runs the long-polling loop and its promise only resolves
    // when bot.stop() is called.  Do NOT await it — that would block the
    // entire startup sequence and prevent other adapters / the event
    // scheduler from initialising.
    this.bot.start().catch((err) => {
      log.error("polling error", {
        error: err instanceof Error ? err.message : String(err),
      });
      // The Connection Talker routes terminal polling failures to its fault
      // channel; ChannelManager passes no callback, so failures are only
      // logged, never surfaced.
      this.onPollingError?.(err);
    });

    log.info("bot started");
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async send(conversationId: ConversationId, message: OutgoingMessage): Promise<MessageReceipt> {
    const threadId: string = conversationId;
    const replyParams = message.replyToMessageId
      ? { reply_parameters: { message_id: Number(message.replyToMessageId) } }
      : {};

    try {
      let messageId: string | undefined;
      if (message.text) {
        let html: string | null = null;
        try {
          html = markdownToTelegramHtml(message.text);
        } catch (mdErr) {
          log.warn("markdown→html conversion failed, will send as plain text", {
            threadId,
            error: mdErr instanceof Error ? mdErr.message : String(mdErr),
            input: message.text.slice(0, 500),
          });
        }

        if (html) {
          log.info("markdown→html conversion", {
            input: message.text.slice(0, 500),
            output: html.slice(0, 500),
          });
          try {
            const sent = await this.bot.api.sendMessage(threadId, html, {
              parse_mode: "HTML",
              ...replyParams,
            });
            messageId = String(sent.message_id);
          } catch (parseErr) {
            log.warn("HTML parse failed, sending as plain text", {
              threadId,
              error: parseErr instanceof Error ? parseErr.message : String(parseErr),
              html: html.slice(0, 500),
            });
            const sent = await this.bot.api.sendMessage(threadId, message.text, replyParams);
            messageId = String(sent.message_id);
          }
        } else {
          const sent = await this.bot.api.sendMessage(threadId, message.text, replyParams);
          messageId = String(sent.message_id);
        }
      }

      for (const att of message.attachments ?? []) {
        await this.sendAttachment(threadId, att);
      }

      log.info("message sent", { threadId });
      return { conversationId, ...(messageId ? { messageId } : {}) };
    } catch (err) {
      log.error("failed to send message", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  onInbound(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /** Download a message's files into the profile. Each attachment's `url` is
   *  its Bot API `file_id`, so the message needs no provider event. */
  async saveIncomingAttachments(message: ChannelMessage): Promise<Attachment[]> {
    const payloads = [];
    for (const attachment of message.attachments) {
      if (!attachment.url) continue;
      const file = await this.bot.api.getFile(attachment.url);
      if (!file.file_path) continue;
      const response = await fetch(
        `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!response.ok) {
        throw new Error(`failed to download Telegram attachment: ${response.status}`);
      }
      try {
        payloads.push({
          attachment,
          data: await readAttachmentResponseBody(response),
          mimeType: response.headers.get("content-type") ?? attachment.mimeType,
          fileName: attachment.fileName ?? basename(file.file_path),
        });
      } catch (err) {
        if (!isAttachmentTooLargeError(err)) throw err;
        log.warn("telegram attachment too large, skipping save", {
          messageId: message.messageId,
          bytes: err.bytes,
          fileName: attachment.fileName ?? basename(file.file_path),
        });
      }
    }
    return saveIncomingAttachmentPayloads(
      {
        channel: message.channel,
        threadId: message.conversationId,
        id: message.messageId,
        attachments: message.attachments,
      },
      payloads,
    );
  }

  private extractAttachments(ctx: Context): Attachment[] {
    const attachments: Attachment[] = [];
    const msg = ctx.message ?? ctx.channelPost;
    if (!msg) return attachments;

    if (msg.photo && msg.photo.length > 0) {
      // Use the largest photo (last in array)
      const largest = msg.photo[msg.photo.length - 1];
      attachments.push({
        type: "image",
        url: largest.file_id,
        caption: msg.caption ?? undefined,
      });
    }

    if (msg.document) {
      attachments.push({
        type: "document",
        url: msg.document.file_id,
        mimeType: msg.document.mime_type ?? undefined,
        fileName: msg.document.file_name ?? undefined,
        caption: msg.caption ?? undefined,
      });
    }

    if (msg.video) {
      attachments.push({
        type: "video",
        url: msg.video.file_id,
        mimeType: msg.video.mime_type ?? undefined,
        fileName: msg.video.file_name ?? undefined,
        caption: msg.caption ?? undefined,
      });
    }

    if (msg.audio) {
      attachments.push({
        type: "audio",
        url: msg.audio.file_id,
        mimeType: msg.audio.mime_type ?? undefined,
        fileName: msg.audio.file_name ?? undefined,
        caption: msg.caption ?? undefined,
      });
    }

    if (msg.sticker) {
      attachments.push({
        type: "sticker",
        url: msg.sticker.file_id,
      });
    }

    return attachments;
  }

  private async sendAttachment(threadId: string, att: OutgoingAttachment): Promise<void> {
    const source = att.source.startsWith("http") ? att.source : new InputFile(att.source);
    const options = att.caption ? { caption: att.caption } : {};

    switch (att.type) {
      case "image":
        await this.bot.api.sendPhoto(threadId, source, options);
        break;
      case "video":
        await this.bot.api.sendVideo(threadId, source, options);
        break;
      case "audio":
        await this.bot.api.sendAudio(threadId, source, options);
        break;
      case "document":
        await this.bot.api.sendDocument(threadId, source, options);
        break;
    }
  }
}
