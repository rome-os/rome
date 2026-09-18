import { traceImApi } from "./diagnostics/api-trace.js";
import { Bot, type Context, InputFile, GrammyError } from "grammy";
import { physicalOperation as schedulePhysicalOperation } from "../connections/delivery/physical-operation.js";
import { DeliveryFailure } from "../connections/delivery/transport.js";
import { plainTextCodec } from "../connections/delivery/transport.js";
import { partBoundary } from "../connections/delivery/parts.js";
import { Marked, Renderer, type Token } from "marked";
import type { ProviderAdapter } from "./adapter.js";
import type {
  NormalizedMessage,
  Attachment,
  OutgoingMessage,
  OutgoingAttachment,
} from "./types.js";
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

export function createTracedTelegramBot(
  token: string,
  createBot: CreateTelegramBot = (value) => new Bot(value),
): Bot {
  const bot = createBot(token);
  bot.api.config.use((previous, method, payload, signal) =>
    traceImApi("telegram", "sdk", { method, body: payload }, () =>
      previous(method, payload, signal),
    ),
  );
  return bot;
}

export class TelegramAdapter implements ProviderAdapter {
  readonly channelName = "telegram";
  private bot: Bot;
  private handler?: (msg: NormalizedMessage) => Promise<void>;
  private onPollingError?: (err: unknown) => void;

  constructor(
    private config: { botToken: string; onPollingError?: (err: unknown) => void },
    createBot: CreateTelegramBot = createTracedTelegramBot,
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

      const msg: NormalizedMessage = {
        id: String(rawMsg.message_id),
        channel: "telegram",
        channelUserId: ctx.channelPost
          ? String(ctx.chat!.id)
          : rawMsg.sender_chat
            ? String(rawMsg.sender_chat.id)
            : ctx.from
              ? String(ctx.from.id)
              : String(ctx.chat!.id),
        displayName:
          ctx.from && !ctx.channelPost && !rawMsg.sender_chat
            ? [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "Unknown"
            : "title" in ctx.chat!
              ? ((ctx.chat as { title?: string }).title ?? "Channel")
              : "Channel",
        username:
          ctx.from && !ctx.channelPost && !rawMsg.sender_chat ? ctx.from.username : undefined,
        threadId: String(ctx.chat!.id),
        threadName: "title" in ctx.chat! ? (ctx.chat as { title?: string }).title : undefined,
        threadType: ctx.chat!.type === "private" ? "private" : "group",
        addressing:
          ctx.chat!.type === "private"
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
        timestamp: new Date(rawMsg.date * 1000),
        text: rawMsg.text ?? rawMsg.caption ?? "",
        attachments: this.extractAttachments(ctx),
        replyTo: rawMsg.reply_to_message
          ? { messageId: String(rawMsg.reply_to_message.message_id) }
          : undefined,
        rawEvent: rawMsg,
      };

      log.info("message received", {
        from: msg.channelUserId,
        threadId: msg.threadId,
        threadType: msg.threadType,
      });

      try {
        await this.handler!(msg);
      } catch (err) {
        log.error("message handler error", {
          messageId: msg.id,
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

  async sendMessage(
    _channelUserId: string,
    threadId: string,
    message: OutgoingMessage,
  ): Promise<{
    messageId?: string;
    threadId: string;
    parts: Array<{ messageId: string; kind: string }>;
  }> {
    if (message.text && message.text.length > 4000) {
      let remaining = message.text;
      const parts: Array<{ messageId: string; kind: string }> = [];
      try {
        while (remaining) {
          const end = partBoundary(remaining, 4000, plainTextCodec);
          const result = await this.sendMessage(_channelUserId, threadId, {
            ...message,
            text: remaining.slice(0, end),
            attachments: end === remaining.length ? message.attachments : undefined,
          });
          parts.push(...result.parts);
          remaining = remaining.slice(end);
        }
      } catch (error) {
        const failure = telegramDeliveryFailure(error);
        throw new DeliveryFailure(failure.kind, failure.message, [
          ...(parts.length
            ? [
                {
                  conversationId: threadId as import("@rome-os/app-runtime").ConversationId,
                  messageId: parts[0].messageId,
                  parts,
                },
              ]
            : []),
          ...failure.receipts,
        ]);
      }
      return { messageId: parts[0]?.messageId, threadId, parts };
    }
    const replyParams = message.replyToMessageId
      ? { reply_parameters: { message_id: Number(message.replyToMessageId) } }
      : {};

    const parts: Array<{ messageId: string; kind: string }> = [];
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
            const sent = await physicalOperation(threadId, "create", () =>
              this.bot.api.sendMessage(threadId, html!, {
                parse_mode: "HTML",
                ...replyParams,
              }),
            );
            messageId = String(sent.message_id);
          } catch (parseErr) {
            if (
              !(parseErr instanceof GrammyError) ||
              parseErr.error_code !== 400 ||
              !/parse entities|unsupported start tag|can't find end tag/i.test(parseErr.description)
            )
              throw parseErr;
            log.warn("HTML parse failed, sending as plain text", {
              threadId,
              error: parseErr instanceof Error ? parseErr.message : String(parseErr),
              html: html.slice(0, 500),
            });
            const sent = await physicalOperation(threadId, "create", () =>
              this.bot.api.sendMessage(threadId, message.text!, replyParams),
            );
            messageId = String(sent.message_id);
          }
        } else {
          const sent = await physicalOperation(threadId, "create", () =>
            this.bot.api.sendMessage(threadId, message.text!, replyParams),
          );
          messageId = String(sent.message_id);
        }
      }

      if (messageId) parts.push({ messageId, kind: "text" });
      for (const att of message.attachments ?? []) {
        const attachmentId = await this.sendAttachment(threadId, att);
        if (attachmentId) {
          messageId ??= attachmentId;
          parts.push({ messageId: attachmentId, kind: att.type });
        }
      }

      log.info("message sent", { threadId });
      return { messageId, threadId, parts };
    } catch (err) {
      log.error("failed to send message", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (parts.length) {
        const failure = telegramDeliveryFailure(err);
        throw new DeliveryFailure(failure.kind, failure.message, [
          {
            conversationId: threadId as import("@rome-os/app-runtime").ConversationId,
            messageId: parts[0].messageId,
            parts,
          },
        ]);
      }
      throw err;
    }
  }

  async createText(threadId: string, text: string, replyToMessageId?: string) {
    try {
      const sent = await physicalOperation(threadId, "create", () =>
        this.bot.api.sendMessage(threadId, text, {
          ...(replyToMessageId
            ? { reply_parameters: { message_id: Number(replyToMessageId) } }
            : {}),
          link_preview_options: { is_disabled: true },
        }),
      );
      return { messageId: String(sent.message_id), threadId: String(sent.chat.id) };
    } catch (error) {
      throw telegramDeliveryFailure(error);
    }
  }

  async updateText(threadId: string, messageId: string, text: string): Promise<void> {
    try {
      await physicalOperation(threadId, "update", () =>
        this.bot.api.editMessageText(threadId, Number(messageId), text, {
          link_preview_options: { is_disabled: true },
        }),
      );
    } catch (error) {
      if (error instanceof GrammyError && /message is not modified/i.test(error.description))
        return;
      throw telegramDeliveryFailure(error);
    }
  }

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async saveIncomingAttachments(message: NormalizedMessage): Promise<Attachment[]> {
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
          messageId: message.id,
          bytes: err.bytes,
          fileName: attachment.fileName ?? basename(file.file_path),
        });
      }
    }
    return saveIncomingAttachmentPayloads(message, payloads);
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

  private async sendAttachment(
    threadId: string,
    att: OutgoingAttachment,
  ): Promise<string | undefined> {
    const source = att.source.startsWith("http") ? att.source : new InputFile(att.source);
    const options = att.caption ? { caption: att.caption } : {};

    switch (att.type) {
      case "image":
        return String(
          (
            await physicalOperation(threadId, "create", () =>
              this.bot.api.sendPhoto(threadId, source, options),
            )
          ).message_id,
        );
      case "video":
        return String(
          (
            await physicalOperation(threadId, "create", () =>
              this.bot.api.sendVideo(threadId, source, options),
            )
          ).message_id,
        );
      case "audio":
        return String(
          (
            await physicalOperation(threadId, "create", () =>
              this.bot.api.sendAudio(threadId, source, options),
            )
          ).message_id,
        );
      case "document":
        return String(
          (
            await physicalOperation(threadId, "create", () =>
              this.bot.api.sendDocument(threadId, source, options),
            )
          ).message_id,
        );
    }
  }
}

function telegramDeliveryFailure(error: unknown): DeliveryFailure {
  if (error instanceof DeliveryFailure) return error;
  if (!(error instanceof GrammyError))
    return new DeliveryFailure("unknown", error instanceof Error ? error.message : String(error));
  if (error.error_code === 429)
    return new DeliveryFailure(
      "rate-limit",
      error.description,
      [],
      (error.parameters.retry_after ?? 1) * 1000,
    );
  if (error.error_code === 401 || error.error_code === 403)
    return new DeliveryFailure("authorization", error.description);
  if (error.error_code === 400 && /can't be edited/i.test(error.description))
    return new DeliveryFailure("unsupported", error.description);
  return new DeliveryFailure("failed", error.description);
}

function physicalOperation<T>(
  conversation: string,
  kind: "create" | "update",
  operation: () => Promise<T>,
): Promise<T> {
  return schedulePhysicalOperation(conversation, kind, async () => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 429)
        throw telegramDeliveryFailure(error);
      throw error;
    }
  });
}
