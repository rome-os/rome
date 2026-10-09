import { Bot } from "grammy";
import { TelegramAdapter } from "../../../channels/telegram.js";
import { exemplar, loadCapture } from "./capture.js";
import textCapture from "./captures/telegram-text.capture.json" with { type: "json" };
import {
  MessageStore,
  PeerServer,
  deferred,
  type Peer,
  type PeerRequest,
  type Reply,
  type VisibleMessage,
} from "./peer.js";

export const TELEGRAM_TOKEN = "123456:fixture-token";
/** The private chat the capture was recorded in. */
export const TELEGRAM_CHAT = 123;

const capture = loadCapture(textCapture);
const sent = exemplar<{ result: RecordedMessage }>(capture, "send").result;
const TEXT_LIMIT = 4096;

interface RecordedMessage extends Record<string, unknown> {
  from: Record<string, unknown>;
  chat: { id: number; first_name?: string; username?: string; type: string };
}

interface Update {
  update_id: number;
  message: Record<string, unknown>;
}

/**
 * The Bot API behind a real grammy `Bot`, over HTTP. Message responses are
 * built from the recorded ones (./captures/telegram-text.capture.json); the
 * lifecycle calls a capture does not cover yet answer with `source:
 * "synthetic"`.
 */
export class TelegramPeer implements Peer {
  readonly server = new PeerServer((request) => this.route(request));
  private readonly store = new MessageStore();
  /** Chats the bot can write to: the recorded one and any a user wrote from. */
  private readonly chats = new Set([String(TELEGRAM_CHAT)]);
  private readonly dates = new Map<string, { date: number; edit_date?: number }>();
  private updates: Update[] = [];
  private nextMessageId = 1;
  private nextUpdateId = 1;
  private readonly polling = deferred();
  private readonly wake = new Set<() => void>();

  static async start(): Promise<TelegramPeer> {
    const peer = new TelegramPeer();
    await peer.server.start();
    return peer;
  }

  close(): Promise<void> {
    return this.server.close();
  }

  untilPolling(): Promise<void> {
    return this.polling.promise;
  }

  visible(chatId: string | number = TELEGRAM_CHAT): VisibleMessage[] {
    return this.store.visible(String(chatId));
  }

  readonly createBot = (token: string) =>
    new Bot(token, {
      client: {
        apiRoot: this.server.url,
        // grammy hands Node abort signals and Readable bodies to fetch; bridge
        // them to native fetch without replacing grammy's serializer.
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const controller = new AbortController();
          const abort = () => controller.abort();
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
          try {
            return await this.server.fetch(input, {
              ...init,
              signal: controller.signal,
              duplex: "half",
            } as RequestInit);
          } finally {
            init?.signal?.removeEventListener("abort", abort);
          }
        },
      },
    });

  createAdapter(): TelegramAdapter {
    return new TelegramAdapter({ botToken: TELEGRAM_TOKEN }, this.createBot);
  }

  /** A user's text message, delivered on the bot's next getUpdates. */
  emitMessage(text: string, chatId = TELEGRAM_CHAT): VisibleMessage {
    this.chats.add(String(chatId));
    const message = this.store.add({
      id: String(this.nextMessageId++),
      conversation: String(chatId),
      from: "user",
      text,
    });
    this.dates.set(message.id, { date: now() });
    this.updates.push({ update_id: this.nextUpdateId++, message: this.wire(message) });
    for (const wake of [...this.wake]) wake();
    return message;
  }

  private async route({ method, path, body, signal }: PeerRequest): Promise<Reply | undefined> {
    const prefix = `/bot${TELEGRAM_TOKEN}/`;
    if (method !== "POST" || !path.startsWith(prefix)) return undefined;
    switch (path.slice(prefix.length)) {
      case "getMe":
        return { body: { ok: true, result: sent.from }, source: "synthetic" };
      case "deleteWebhook":
      case "sendChatAction":
        return { body: { ok: true, result: true }, source: "synthetic" };
      case "getUpdates":
        return this.getUpdates(body, signal);
      case "sendMessage":
        return this.sendMessage(body);
      case "editMessageText":
        return this.editMessageText(body);
      default:
        return undefined;
    }
  }

  private async getUpdates(body: Record<string, unknown>, signal: AbortSignal): Promise<Reply> {
    this.polling.resolve();
    const offset = Number(body.offset ?? 0);
    this.updates = this.updates.filter((update) => update.update_id >= offset);
    if (!this.updates.length && Number(body.timeout ?? 0) > 0 && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          this.wake.delete(finish);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        this.wake.add(finish);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
    return { body: { ok: true, result: this.updates }, source: "synthetic" };
  }

  private sendMessage(body: Record<string, unknown>): Reply {
    const chat = String(body.chat_id);
    if (!this.chats.has(chat)) return badRequest("chat not found");
    const text = String(body.text ?? "");
    const length = visibleLength(text, body.parse_mode);
    if (length === 0) return badRequest("message text is empty");
    if (length > TEXT_LIMIT) return badRequest("message is too long");
    const replyTo = (body.reply_parameters as { message_id?: number } | undefined)?.message_id;
    if (replyTo !== undefined && this.store.get(String(replyTo))?.conversation !== chat)
      return badRequest("message to be replied not found");

    const message = this.store.add({
      id: String(this.nextMessageId++),
      conversation: chat,
      from: "rome",
      text,
      ...(replyTo !== undefined ? { replyTo: String(replyTo) } : {}),
    });
    this.dates.set(message.id, { date: now() });
    return { body: { ok: true, result: this.wire(message) }, source: "capture", accepted: true };
  }

  private editMessageText(body: Record<string, unknown>): Reply {
    const message = this.store.get(String(body.message_id));
    if (!message || message.conversation !== String(body.chat_id))
      return { status: 400, body: exemplar(capture, "edit-missing"), source: "capture" };
    if (message.from !== "rome") return badRequest("message can't be edited");
    const text = String(body.text ?? "");
    const length = visibleLength(text, body.parse_mode);
    if (length === 0) return badRequest("message text is empty");
    if (length > TEXT_LIMIT) return badRequest("message is too long");
    if (text === message.text)
      return badRequest(
        "message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      );
    this.store.edit(message.id, text);
    this.dates.set(message.id, { ...this.dates.get(message.id)!, edit_date: now() });
    return { body: { ok: true, result: this.wire(message) }, source: "capture", accepted: true };
  }

  /** A stored message as the Bot API spells it, from the recorded message. */
  private wire(message: VisibleMessage): Record<string, unknown> {
    const parent = message.replyTo ? this.store.get(message.replyTo) : undefined;
    return {
      ...structuredClone(sent),
      message_id: Number(message.id),
      ...(message.from === "user"
        ? { from: { ...userOf(sent.chat), id: Number(message.conversation) } }
        : {}),
      chat: { ...sent.chat, id: Number(message.conversation) },
      ...this.dates.get(message.id),
      text: message.text,
      ...(parent ? { reply_to_message: this.wire(parent) } : {}),
    };
  }
}

/** The person in a private chat, as Telegram names a message's sender. */
function userOf({ id, first_name, username }: RecordedMessage["chat"]) {
  return { id, is_bot: false, first_name, username };
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

// No capture covers these rejections yet. The descriptions follow the Bot API's.
function badRequest(reason: string): Reply {
  return {
    status: 400,
    body: { ok: false, error_code: 400, description: `Bad Request: ${reason}` },
    source: "synthetic",
  };
}

/** Telegram limits the text a user sees: after HTML entities are parsed, in
 *  UTF-16 code units. */
function visibleLength(text: string, parseMode: unknown): number {
  if (parseMode !== "HTML") return text.length;
  // Count what is outside tags, with each entity as one character.
  let length = 0;
  let inTag = false;
  let inEntity = false;
  for (const char of text) {
    if (inTag) inTag = char !== ">";
    else if (char === "<") inTag = true;
    else if (inEntity) inEntity = char !== ";";
    else {
      length += 1;
      inEntity = char === "&";
    }
  }
  return length;
}
