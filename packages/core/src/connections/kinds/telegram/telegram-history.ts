// The history a Telegram bot keeps of its own chats. Prototype.
//
// The Bot API gives a bot no way to read a chat's past messages: it hears each
// update once. So the connection keeps what its bot heard and said, one file
// per chat, and its `telegram_read_history` tool reads it. No client library
// keeps this for a bot (grammY offers session storage, not message history),
// so it is kept here. It holds only what Telegram delivered to the bot: in a
// group with privacy mode on, that is mentions, replies to the bot and
// commands, never the rest of the group.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** One message in a bot's history. */
export interface TelegramHistoryMessage {
  /** Telegram's id for the message, unique in its chat. */
  id: string;
  /** Who said it, as Telegram named them, or "you" for the bot itself. */
  from: string;
  fromId: string;
  at: string;
  text: string;
  replyTo?: string;
  /** Kinds of what was attached, as `photo` or `document`. */
  attachments?: string[];
}

/** How many messages a chat's history keeps. Past it the oldest go. */
const KEPT_PER_CHAT = 2000;

export class TelegramHistory {
  private readonly chats = new Map<string, TelegramHistoryMessage[]>();

  /** `dir` holds one file per chat. Created on the first write. */
  constructor(private readonly dir: string) {}

  /** Keep `message`, said in chat `chatId`. A message kept already is kept
   *  once. Never throws: history is a convenience, not a record. */
  keep(chatId: string, message: TelegramHistoryMessage): void {
    try {
      const held = this.load(chatId);
      if (held.some((each) => each.id === message.id)) return;
      held.push(message);
      mkdirSync(this.dir, { recursive: true });
      if (held.length > KEPT_PER_CHAT * 1.5) {
        held.splice(0, held.length - KEPT_PER_CHAT);
        writeFileSync(this.file(chatId), held.map((each) => `${JSON.stringify(each)}\n`).join(""));
      } else {
        appendFileSync(this.file(chatId), `${JSON.stringify(message)}\n`);
      }
    } catch {
      // A history that cannot be written leaves the tool reading less.
    }
  }

  /** Message `id` of chat `chatId` now reads `text`, as a streamed reply
   *  does once it is edited. Never throws. */
  revise(chatId: string, id: string, text: string): void {
    try {
      const held = this.load(chatId).find((each) => each.id === id);
      if (!held || held.text === text) return;
      held.text = text;
      appendFileSync(this.file(chatId), `${JSON.stringify(held)}\n`);
    } catch {
      // As for keep.
    }
  }

  /** Up to `limit` messages of chat `chatId`, newest first, before message
   *  `before` when named. */
  read(chatId: string, options: { limit: number; before?: string }): TelegramHistoryMessage[] {
    const held = this.load(chatId);
    const end =
      options.before === undefined
        ? held.length
        : held.findIndex((each) => each.id === options.before);
    const upTo = end < 0 ? held.length : end;
    return held.slice(Math.max(0, upTo - options.limit), upTo).reverse();
  }

  private load(chatId: string): TelegramHistoryMessage[] {
    const cached = this.chats.get(chatId);
    if (cached) return cached;
    const file = this.file(chatId);
    const held: TelegramHistoryMessage[] = [];
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as TelegramHistoryMessage;
          // A message written again was revised: the last write wins.
          const at = held.findIndex((each) => each.id === message.id);
          if (at >= 0) held[at] = message;
          else held.push(message);
        } catch {
          // A torn last line from a crash is skipped.
        }
      }
    }
    this.chats.set(chatId, held);
    return held;
  }

  private file(chatId: string): string {
    return join(this.dir, `${chatId.replace(/[^0-9A-Za-z_-]/g, "_")}.jsonl`);
  }
}
