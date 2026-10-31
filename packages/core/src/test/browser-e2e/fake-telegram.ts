import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";

// A loopback stand-in for the Telegram Bot API, for the browser suite. It
// models several bots at once, so two of Rome's Telegram accounts can sit in
// one group. grammy fetches through node-fetch, not the global fetch, so the
// launcher swaps node-fetch's export for `route()` before Rome builds a bot.
//
// Message ids follow Telegram's rules
// (https://core.telegram.org/api/bots/ids): in a private chat or a basic group
// each bot numbers the messages it sees on its own, and in a supergroup the
// group numbers them once for everyone. That difference is what the chats
// migration has to keep apart, so the fake keeps it too.
//
// The unit-level peer in ../kit/im/telegram.ts replays recorded answers for one
// bot in one private chat; this one only has to keep a real Rome talking.

const TELEGRAM_ORIGIN = "https://api.telegram.org";

export interface TelegramBot {
  token: string;
  id: number;
  username: string;
  first_name: string;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup";
  title?: string;
}

/** A message as one bot saw or sent it. */
export interface TelegramLogEntry {
  bot: string;
  chatId: number;
  messageId: number;
  from: string;
  text: string;
  replyTo?: number;
}

interface WireMessage extends Record<string, unknown> {
  message_id: number;
  chat: Record<string, unknown>;
  text: string;
}

export const TELEGRAM_BOTS: TelegramBot[] = [
  {
    token: "7000000001:e2e-alpha-token",
    id: 7000000001,
    username: "e2e_alpha_bot",
    first_name: "Alpha",
  },
  {
    token: "7000000002:e2e-beta-token",
    id: 7000000002,
    username: "e2e_beta_bot",
    first_name: "Beta",
  },
];

export class FakeTelegram {
  /** Every text message each bot saw or sent, in order. */
  readonly messages: TelegramLogEntry[] = [];
  readonly unhandled: string[] = [];
  private readonly updates = new Map<string, Array<{ update_id: number; message: WireMessage }>>();
  /** Per bot and chat for private chats and basic groups; per chat for supergroups. */
  private readonly counters = new Map<string, number>();
  /** What each bot's message ids stand for, so a reply can point at one. */
  private readonly sent = new Map<string, WireMessage>();
  private readonly chats = new Map<number, TelegramChat>();
  private readonly wake = new Set<() => void>();
  private nextUpdateId = 1;

  /** `firstId` is the first message id in each chat. A fixture's chats
   *  already hold low ids, so a run over one starts above them. */
  constructor(private readonly firstId = 1) {}

  private readonly server: Server = createServer((req, res) => {
    void this.handle(req, res).catch((error: unknown) => {
      this.unhandled.push(`error ${req.method} ${req.url}: ${String(error)}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
  }

  /** Points grammy's HTTP client at this server. grammy reads node-fetch's
   *  `default` export when it builds a bot, so this runs before Rome boots. */
  installForGrammy(): void {
    const fromGrammy = createRequire(createRequire(import.meta.url).resolve("grammy"));
    const nodeFetch = fromGrammy("node-fetch") as { default: typeof fetch };
    const original = nodeFetch.default;
    nodeFetch.default = ((input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== TELEGRAM_ORIGIN) return original(input, init);
      // grammy hands node-fetch an https agent for its https apiRoot, which
      // cannot carry a plain http request.
      const { agent: _agent, ...rest } = (init ?? {}) as RequestInit & { agent?: unknown };
      return original(`${this.url}${url.pathname}${url.search}`, rest);
    }) as typeof fetch;
  }

  /**
   * A person writes in a chat. Every bot in `bots` receives it on its next
   * poll; `mention` names one bot with an @handle entity, and `replyTo` names
   * a message as `bot` numbered it.
   */
  emit(input: {
    chat: TelegramChat;
    from: TelegramUser;
    text: string;
    bots: string[];
    mention?: string;
    replyTo?: { bot: string; messageId: number };
  }): Record<string, number> {
    this.chats.set(input.chat.id, input.chat);
    const ids: Record<string, number> = {};
    const date = Math.floor(Date.now() / 1000);
    const shared = input.chat.type === "supergroup" ? this.nextId(input.chat.id) : undefined;
    for (const username of input.bots) {
      const bot = botNamed(username);
      const messageId = shared ?? this.nextId(input.chat.id, bot.username);
      ids[bot.username] = messageId;
      const message: WireMessage = {
        message_id: messageId,
        from: {
          id: input.from.id,
          is_bot: false,
          first_name: input.from.first_name,
          ...(input.from.username ? { username: input.from.username } : {}),
        },
        chat: chatWire(input.chat, input.from),
        date,
        text: input.text,
      };
      if (input.mention) {
        const handle = `@${botNamed(input.mention).username}`;
        const offset = input.text.indexOf(handle);
        if (offset >= 0) message.entities = [{ type: "mention", offset, length: handle.length }];
      }
      if (input.replyTo && input.replyTo.bot === bot.username) {
        const parent = this.sent.get(key(bot.username, input.chat.id, input.replyTo.messageId));
        if (parent) message.reply_to_message = parent;
      }
      this.sent.set(key(bot.username, input.chat.id, messageId), message);
      this.queue(bot.token).push({ update_id: this.nextUpdateId++, message });
      this.messages.push({
        bot: bot.username,
        chatId: input.chat.id,
        messageId,
        from: input.from.username ?? String(input.from.id),
        text: input.text,
        ...(message.reply_to_message ? { replyTo: input.replyTo!.messageId } : {}),
      });
    }
    for (const wake of [...this.wake]) wake();
    return ids;
  }

  close(): Promise<void> {
    for (const wake of [...this.wake]) wake();
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private queue(token: string) {
    let queue = this.updates.get(token);
    if (!queue) this.updates.set(token, (queue = []));
    return queue;
  }

  private nextId(chatId: number, bot?: string): number {
    const k = bot ? `${bot}:${chatId}` : `chat:${chatId}`;
    const next = (this.counters.get(k) ?? this.firstId - 1) + 1;
    this.counters.set(k, next);
    return next;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    const ok = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    };
    const bot = match ? TELEGRAM_BOTS.find((b) => b.token === match[1]) : undefined;
    if (!match || !bot) {
      this.unhandled.push(`${req.method} ${url.pathname.replace(/bot[^/]+/, "bot<token>")}`);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
      return;
    }
    const body = await readJson(req);
    switch (match[2]) {
      case "getMe":
        return ok({
          id: bot.id,
          is_bot: true,
          first_name: bot.first_name,
          username: bot.username,
          can_join_groups: true,
          can_read_all_group_messages: true,
        });
      case "deleteWebhook":
      case "sendChatAction":
      case "setMyCommands":
      case "setMessageReaction":
        return ok(true);
      case "getUpdates":
        return ok(await this.getUpdates(bot.token, body, res));
      case "sendMessage":
        return ok(this.sendMessage(bot, body));
      case "editMessageText":
        return ok(this.editMessageText(bot, body));
      default:
        this.unhandled.push(`POST ${match[2]}`);
        return ok(true);
    }
  }

  private async getUpdates(token: string, body: Record<string, unknown>, res: ServerResponse) {
    const offset = Number(body.offset ?? 0);
    const queue = this.queue(token);
    while (queue.length && queue[0]!.update_id < offset) queue.shift();
    if (!queue.length && Number(body.timeout ?? 0) > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, 10_000);
        function finish() {
          clearTimeout(timer);
          resolve();
        }
        const wake = () => {
          this.wake.delete(wake);
          finish();
        };
        this.wake.add(wake);
        res.once("close", wake);
      });
    }
    return [...queue];
  }

  private sendMessage(bot: TelegramBot, body: Record<string, unknown>): WireMessage {
    const chatId = Number(body.chat_id);
    const chat = this.chats.get(chatId) ?? { id: chatId, type: "private" as const };
    const messageId =
      chat.type === "supergroup" ? this.nextId(chatId) : this.nextId(chatId, bot.username);
    const replyTo = (body.reply_parameters as { message_id?: number } | undefined)?.message_id;
    const message: WireMessage = {
      message_id: messageId,
      from: { id: bot.id, is_bot: true, first_name: bot.first_name, username: bot.username },
      chat: chatWire(chat),
      date: Math.floor(Date.now() / 1000),
      text: String(body.text ?? ""),
    };
    if (replyTo !== undefined) {
      const parent = this.sent.get(key(bot.username, chatId, replyTo));
      if (parent) message.reply_to_message = parent;
    }
    this.sent.set(key(bot.username, chatId, messageId), message);
    this.messages.push({
      bot: bot.username,
      chatId,
      messageId,
      from: bot.username,
      text: message.text,
      ...(replyTo !== undefined ? { replyTo } : {}),
    });
    return message;
  }

  private editMessageText(bot: TelegramBot, body: Record<string, unknown>): WireMessage {
    const message = this.sent.get(key(bot.username, Number(body.chat_id), Number(body.message_id)));
    if (!message) throw new Error(`edit of a missing message ${String(body.message_id)}`);
    message.text = String(body.text ?? "");
    const entry = this.messages.findLast(
      (m) =>
        m.bot === bot.username &&
        m.chatId === Number(body.chat_id) &&
        m.messageId === message.message_id,
    );
    if (entry) entry.text = message.text;
    return { ...message, edit_date: Math.floor(Date.now() / 1000) };
  }
}

function botNamed(username: string): TelegramBot {
  const bot = TELEGRAM_BOTS.find((b) => b.username === username);
  if (!bot) throw new Error(`no fake Telegram bot named ${username}`);
  return bot;
}

function key(bot: string, chatId: number, messageId: number): string {
  return `${bot}:${chatId}:${messageId}`;
}

function chatWire(chat: TelegramChat, person?: TelegramUser): Record<string, unknown> {
  if (chat.type === "private")
    return {
      id: chat.id,
      type: "private",
      first_name: person?.first_name ?? "E2E",
      ...(person?.username ? { username: person.username } : {}),
    };
  return { id: chat.id, type: chat.type, title: chat.title ?? "E2E group" };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}
