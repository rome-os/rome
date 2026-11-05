// The tools a Telegram bot gives an agent woken through it. Prototype.
// Each connection kind names its own tools, as its platform reads
// (`ConnectionTools` in connections/types.ts).

import type { ConnectionTools } from "../../types.js";
import type { TelegramAdapter } from "./telegram.js";
import type { TelegramHistory } from "./telegram-history.js";

const GUIDE = [
  "Telegram keeps no history a bot can read, so this bot keeps its own: what Telegram delivered to it and what it said, since the bot was connected.",
  "In a group with privacy mode on, Telegram delivers only mentions, replies to the bot and commands, so the rest of the group is not there.",
  "- telegram_read_history: read this chat's messages the bot kept, newest first. Page back with `before`.",
  "- telegram_react: react to a message with one of Telegram's reaction emoji (👍 ❤ 🔥 🎉 👀 🤔 👏 and so on). An empty emoji takes the reaction back.",
].join("\n");

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function telegramTools(
  adapter: Pick<TelegramAdapter, "react">,
  history: Pick<TelegramHistory, "read">,
): ConnectionTools {
  return {
    guide: GUIDE,
    async call(tool, args) {
      switch (tool) {
        case "telegram_read_history": {
          const limit =
            typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 200) : 50;
          const messages = history.read(text(args.chatId, "chatId"), {
            limit,
            ...(typeof args.before === "string" && args.before ? { before: args.before } : {}),
          });
          return {
            messages,
            ...(messages.length === limit ? { before: messages.at(-1)?.id } : {}),
          };
        }
        case "telegram_react": {
          const emoji = typeof args.emoji === "string" ? args.emoji : "";
          await adapter.react(
            text(args.chatId, "chatId"),
            text(args.messageId, "messageId"),
            emoji,
          );
          return { reacted: emoji || null };
        }
        default:
          throw new Error(`A Telegram bot has no tool ${tool}`);
      }
    },
  };
}
