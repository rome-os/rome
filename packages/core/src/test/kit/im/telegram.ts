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
  /** Each message's entities, serialized for the "not modified" check. */
  private readonly formatting = new Map<string, string>();
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
    const read = readText(body);
    if (!("text" in read)) return read;
    const { text, formatting, source } = read;
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
    this.formatting.set(message.id, formatting);
    return { body: { ok: true, result: this.wire(message) }, source, accepted: true };
  }

  private editMessageText(body: Record<string, unknown>): Reply {
    const message = this.store.get(String(body.message_id));
    if (!message || message.conversation !== String(body.chat_id))
      return { status: 400, body: exemplar(capture, "edit-missing"), source: "capture" };
    if (message.from !== "rome") return badRequest("message can't be edited");
    const read = readText(body);
    if (!("text" in read)) return read;
    const { text, formatting, source } = read;
    if (text === message.text && formatting === this.formatting.get(message.id))
      return badRequest(
        "message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      );
    this.store.edit(message.id, text);
    this.formatting.set(message.id, formatting);
    this.dates.set(message.id, { ...this.dates.get(message.id)!, edit_date: now() });
    return { body: { ok: true, result: this.wire(message) }, source, accepted: true };
  }

  /** A stored message as the Bot API spells it, from the recorded message. The
   *  message a reply points at carries no reply of its own, as in the Bot API. */
  private wire(message: VisibleMessage, nested = false): Record<string, unknown> {
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
): { text: string; formatting: string; source: "capture" | "synthetic" } | Reply {
  const raw = String(body.text ?? "");
  const html = body.parse_mode === "HTML";
  const parsed = html ? parseHtml(raw) : { text: raw, entities: [] };
  if (!parsed) return badRequest("can't parse entities");
  const { text, entities } = trim(parsed);
  if (!text) return badRequest("message text is empty");
  if (text.length > TEXT_LIMIT) return badRequest("message is too long");
  // Telegram compares entities, not the HTML that spelled them, so `<b>` and
  // `<strong>` are the same formatting.
  const formatting = JSON.stringify(entities);
  return { text, formatting, source: html ? "synthetic" : "capture" };
}

/** A formatted span: its canonical kind and the attributes that matter. */
interface Entity {
  type: string;
  offset: number;
  length: number;
}

/**
 * Drops the whitespace Telegram drops: before the first entity and after the
 * last, so the indentation inside a `<pre>` survives.
 */
function trim({ text, entities }: { text: string; entities: Entity[] }) {
  const first = Math.min(text.length, ...entities.map((e) => e.offset));
  const last = Math.max(0, ...entities.map((e) => e.offset + e.length));
  let start = 0;
  while (start < first && /\s/.test(text[start]!)) start += 1;
  let end = text.length;
  while (end > Math.max(last, start) && /\s/.test(text[end - 1]!)) end -= 1;
  return {
    text: text.slice(start, end),
    entities: entities.map((e) => ({ ...e, offset: e.offset - start })),
  };
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
// Tags that spell the same entity as another.
const SAME_AS: Record<string, string> = {
  strong: "b",
  em: "i",
  ins: "u",
  strike: "s",
  del: "s",
  span: "tg-spoiler",
};
const HTML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"' };

// A well-formed tag: a name, then attributes with matched quotes. A closing tag
// carries no attributes.
const OPENING_TAG = /^[a-z-]+(\s+[a-z-]+(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*$/i;
const CLOSING_TAG = /^\/[a-z-]+\s*$/i;
const ATTRIBUTE = /([a-z-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gi;

// Tags Telegram accepts only with an attribute: a spoiler span and a custom emoji.
const REQUIRED_ATTRIBUTES: Record<string, RegExp> = {
  span: /\bclass\s*=\s*"tg-spoiler"/,
  "tg-emoji": /\bemoji-id\s*=\s*"\d+"/,
};

/**
 * The text and entities of Telegram HTML, or null where Telegram cannot parse
 * it: a malformed, unsupported, unclosed or misnested tag, one missing its
 * required attribute, or an attribute without a value other than
 * `<blockquote expandable>`. As in tdlib's parser, only `<` starts markup: a
 * `&` that starts no entity, and any `>` outside a tag, are literal text.
 */
function parseHtml(html: string): { text: string; entities: Entity[] } | null {
  const open: { name: string; type: string; offset: number }[] = [];
  const entities: Entity[] = [];
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
      if (closing) {
        const entity = open.pop();
        if (entity?.name !== name) return null;
        // Telegram keeps no entity that covers nothing.
        if (text.length > entity.offset)
          entities.push({
            type: entity.type,
            offset: entity.offset,
            length: text.length - entity.offset,
          });
      } else {
        if (REQUIRED_ATTRIBUTES[name]?.test(tag) === false) return null;
        const attributes = [...tag.slice(name.length).matchAll(ATTRIBUTE)].map(
          ([, key, value]) => [key!.toLowerCase(), value?.replace(/^["']|["']$/g, "")] as const,
        );
        if (
          attributes.some(
            ([key, value]) =>
              value === undefined && !(name === "blockquote" && key === "expandable"),
          )
        )
          return null;
        // A spoiler span's class only says what it is.
        const kept =
          name === "span" ? [] : attributes.map(([key, value]) => `${key}=${value ?? ""}`);
        open.push({
          name,
          type: [SAME_AS[name] ?? name, ...kept.sort()].join(" "),
          offset: text.length,
        });
      }
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
  return open.length
    ? null
    : {
        text,
        entities: entities.sort(
          (a, b) => a.offset - b.offset || b.length - a.length || a.type.localeCompare(b.type),
        ),
      };
}

function decodeEntity(name: string): string | undefined {
  if (Object.hasOwn(HTML_ENTITIES, name)) return HTML_ENTITIES[name];
  const decimal = /^#(\d+)$/.exec(name)?.[1];
  const hex = /^#x([\da-f]+)$/i.exec(name)?.[1];
  if (decimal === undefined && hex === undefined) return undefined;
  const code = decimal ? Number(decimal) : Number.parseInt(hex!, 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
}
