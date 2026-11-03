import { Bot } from "grammy";
import { TelegramAdapter } from "../../../channels/telegram.js";
import { exemplar, loadCapture } from "./capture.js";
import textCapture from "./captures/telegram-text.capture.json" with { type: "json" };
import {
  MessageStore,
  type MessageChange,
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
/** A second bot, another of Rome's accounts. */
export const TELEGRAM_SECOND_TOKEN = "654321:fixture-token-2";
/** A supergroup both bots are admins of. A supergroup numbers its messages
 *  once for every member, so both bots read a message under one id. */
export const TELEGRAM_GROUP = -1001000000001;
const GROUP_TITLE = "Fixture group";

const capture = loadCapture(textCapture);
const sent = exemplar<{ result: RecordedMessage }>(capture, "send").result;
const TEXT_LIMIT = 4096;
/** Each bot by its token, as getMe answers for it. */
const BOTS = new Map<string, Record<string, unknown>>([
  [TELEGRAM_TOKEN, sent.from],
  [
    TELEGRAM_SECOND_TOKEN,
    { id: 654321, is_bot: true, first_name: "Rome Two", username: "rome_fixture_2_bot" },
  ],
]);

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
  private readonly chats = new Set([String(TELEGRAM_CHAT), String(TELEGRAM_GROUP)]);
  private readonly dates = new Map<string, { date: number; edit_date?: number }>();
  private readonly markup = new Map<string, string>();
  /** The bot that sent each of Rome's messages, by its token. */
  private readonly senders = new Map<string, string>();
  /** Each bot's pending updates, by its token. */
  private readonly updates = new Map<string, Update[]>(
    [...BOTS.keys()].map((token) => [token, []]),
  );
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

  changes(chatId: string | number = TELEGRAM_CHAT): MessageChange[] {
    return this.store.changes(String(chatId));
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

  createAdapter(token = TELEGRAM_TOKEN): TelegramAdapter {
    return new TelegramAdapter({ botToken: token }, this.createBot);
  }

  /** A user's text message, delivered on the next getUpdates of every bot in
   *  the chat: the first bot alone in a private chat, and both in the group,
   *  where an admin bot hears every message. */
  emitMessage(text: string, chatId = TELEGRAM_CHAT): VisibleMessage {
    this.chats.add(String(chatId));
    const message = this.store.add({
      id: String(this.nextMessageId++),
      conversation: String(chatId),
      from: "user",
      text,
    });
    this.dates.set(message.id, { date: now() });
    const hearing = chatId === TELEGRAM_GROUP ? [...BOTS.keys()] : [TELEGRAM_TOKEN];
    for (const token of hearing)
      this.updates
        .get(token)!
        .push({ update_id: this.nextUpdateId++, message: this.wire(message) });
    for (const wake of [...this.wake]) wake();
    return message;
  }

  private async route({ method, path, body, signal }: PeerRequest): Promise<Reply | undefined> {
    const [, token, call] = /^\/bot([^/]+)\/(\w+)$/.exec(path) ?? [];
    if (method !== "POST" || !token || !BOTS.has(token)) return undefined;
    switch (call) {
      case "getMe":
        return { body: { ok: true, result: BOTS.get(token) }, source: "synthetic" };
      case "deleteWebhook":
      case "sendChatAction":
        return { body: { ok: true, result: true }, source: "synthetic" };
      case "getUpdates":
        return this.getUpdates(token, body, signal);
      case "sendMessage":
        return this.sendMessage(token, body);
      case "editMessageText":
        return this.editMessageText(body);
      default:
        return undefined;
    }
  }

  private async getUpdates(
    token: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Reply> {
    this.polling.resolve();
    const offset = Number(body.offset ?? 0);
    const pending = () =>
      this.updates
        .set(
          token,
          this.updates.get(token)!.filter((update) => update.update_id >= offset),
        )
        .get(token)!;
    if (!pending().length && Number(body.timeout ?? 0) > 0 && !signal.aborted) {
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
    return { body: { ok: true, result: pending() }, source: "synthetic" };
  }

  private sendMessage(token: string, body: Record<string, unknown>): Reply {
    const chat = String(body.chat_id);
    if (!this.chats.has(chat)) return badRequest("chat not found");
    const read = readText(body);
    if (!("text" in read)) return read;
    const { text, markup, source } = read;
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
    this.markup.set(message.id, markup);
    this.senders.set(message.id, token);
    return { body: { ok: true, result: this.wire(message) }, source, accepted: true };
  }

  private editMessageText(body: Record<string, unknown>): Reply {
    const message = this.store.get(String(body.message_id));
    if (!message || message.conversation !== String(body.chat_id))
      return { status: 400, body: exemplar(capture, "edit-missing"), source: "capture" };
    if (message.from !== "rome") return badRequest("message can't be edited");
    const read = readText(body);
    if (!("text" in read)) return read;
    const { text, markup, source } = read;
    if (text === message.text && markup === this.markup.get(message.id))
      return badRequest(
        "message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      );
    this.store.edit(message.id, text);
    this.markup.set(message.id, markup);
    this.dates.set(message.id, { ...this.dates.get(message.id)!, edit_date: now() });
    return { body: { ok: true, result: this.wire(message) }, source, accepted: true };
  }

  /** A stored message as the Bot API spells it, from the recorded message. The
   *  message a reply points at carries no reply of its own, as in the Bot API. */
  private wire(message: VisibleMessage, nested = false): Record<string, unknown> {
    const parent = message.replyTo ? this.store.get(message.replyTo) : undefined;
    const group = Number(message.conversation) === TELEGRAM_GROUP;
    return {
      ...structuredClone(sent),
      message_id: Number(message.id),
      from:
        message.from === "user"
          ? // The person writes in the group under the id of their private chat.
            { ...userOf(sent.chat), id: group ? TELEGRAM_CHAT : Number(message.conversation) }
          : BOTS.get(this.senders.get(message.id) ?? TELEGRAM_TOKEN),
      chat: group
        ? { id: TELEGRAM_GROUP, title: GROUP_TITLE, type: "supergroup" }
        : { ...sent.chat, id: Number(message.conversation) },
      ...this.dates.get(message.id),
      text: message.text,
      ...(parent && !nested ? { reply_to_message: this.wire(parent, true) } : {}),
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

/**
 * The text a user would see for a send or edit, or Telegram's refusal. HTML is
 * parsed as Telegram parses it, and refused where Telegram would refuse it.
 * The limit counts UTF-16 code units of the parsed text. No capture records an
 * HTML send, so its answer is synthetic.
 */
function readText(
  body: Record<string, unknown>,
): { text: string; markup: string; source: "capture" | "synthetic" } | Reply {
  const raw = String(body.text ?? "");
  const html = body.parse_mode === "HTML";
  // Telegram drops leading and trailing whitespace from what it shows.
  const text = (html ? parseHtml(raw) : raw)?.trim();
  if (text === undefined) return badRequest("can't parse entities");
  if (!text) return badRequest("message text is empty");
  if (text.length > TEXT_LIMIT) return badRequest("message is too long");
  // Stands in for Telegram's entities: an edit that only changes formatting
  // changes this, not the text.
  const markup = html ? raw.trim() : "";
  return { text, markup, source: html ? "synthetic" : "capture" };
}

// The Bot API's HTML formatting: https://core.telegram.org/bots/api#html-style
const HTML_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "code",
  "del",
  "em",
  "i",
  "ins",
  "pre",
  "s",
  "span",
  "strike",
  "strong",
  "tg-emoji",
  "tg-spoiler",
  "u",
]);
const HTML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"' };

// A well-formed tag: a name, then `name=value` attributes with matched quotes.
// A closing tag carries no attributes.
const OPENING_TAG = /^[a-z-]+(\s+[a-z-]+\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))*\s*$/i;
const CLOSING_TAG = /^\/[a-z-]+\s*$/i;

// Tags Telegram accepts only with an attribute: a spoiler span and a custom emoji.
const REQUIRED_ATTRIBUTES: Record<string, RegExp> = {
  span: /\bclass\s*=\s*"tg-spoiler"/,
  "tg-emoji": /\bemoji-id\s*=\s*"\d+"/,
};

/**
 * The text of Telegram HTML, or null where Telegram cannot parse it: a
 * malformed, unsupported, unclosed or misnested tag, or one missing its
 * required attribute. As in tdlib's parser, only `<` starts markup: a `&` that starts
 * no entity, and any `>` outside a tag, are literal text.
 */
function parseHtml(html: string): string | null {
  const open: string[] = [];
  let text = "";
  let at = 0;
  while (at < html.length) {
    const char = html[at]!;
    if (char === "<") {
      const end = html.indexOf(">", at);
      if (end < 0) return null;
      const tag = html.slice(at + 1, end);
      const closing = tag.startsWith("/");
      if (!(closing ? CLOSING_TAG : OPENING_TAG).test(tag)) return null;
      const name = (closing ? tag.slice(1) : tag).split(/\s/)[0]!.toLowerCase();
      if (!HTML_TAGS.has(name)) return null;
      if (!closing && REQUIRED_ATTRIBUTES[name]?.test(tag) === false) return null;
      if (!closing) open.push(name);
      else if (open.pop() !== name) return null;
      at = end + 1;
    } else if (char === "&") {
      const end = html.indexOf(";", at);
      const decoded = end < 0 ? undefined : decodeEntity(html.slice(at + 1, end));
      text += decoded ?? "&";
      at = decoded === undefined ? at + 1 : end + 1;
    } else {
      text += char;
      at += 1;
    }
  }
  return open.length ? null : text;
}

function decodeEntity(name: string): string | undefined {
  if (Object.hasOwn(HTML_ENTITIES, name)) return HTML_ENTITIES[name];
  const decimal = /^#(\d+)$/.exec(name)?.[1];
  const hex = /^#x([\da-f]+)$/i.exec(name)?.[1];
  if (decimal === undefined && hex === undefined) return undefined;
  const code = decimal ? Number(decimal) : Number.parseInt(hex!, 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
}
