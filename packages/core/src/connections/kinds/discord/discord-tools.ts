// The tools a Discord bot gives an agent woken through it. Prototype.
// Each connection kind names its own tools, as its platform reads
// (`ConnectionTools` in connections/types.ts).

import type { ConnectionTools } from "../../types.js";
import type { DiscordAdapter } from "./discord.js";

const GUIDE = [
  "Discord keeps every channel's history, and this bot can read it where it has the Read Message History permission.",
  "- discord_read_messages: read a channel's or thread's messages from Discord, newest first, up to 100 at a time. Page back with `before` (a message id), or forward with `after`.",
  "- discord_react: react to a message with a Unicode emoji, or a server emoji as name:id.",
].join("\n");

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function discordTools(
  adapter: Pick<DiscordAdapter, "readMessages" | "react">,
): ConnectionTools {
  return {
    guide: GUIDE,
    async call(tool, args) {
      switch (tool) {
        case "discord_read_messages": {
          const limit = typeof args.limit === "number" ? args.limit : 50;
          const messages = await adapter.readMessages(text(args.channelId, "channelId"), {
            limit,
            ...(typeof args.before === "string" && args.before ? { before: args.before } : {}),
            ...(typeof args.after === "string" && args.after ? { after: args.after } : {}),
          });
          return { messages };
        }
        case "discord_react": {
          await adapter.react(
            text(args.channelId, "channelId"),
            text(args.messageId, "messageId"),
            text(args.emoji, "emoji"),
          );
          return { reacted: args.emoji };
        }
        default:
          throw new Error(`A Discord bot has no tool ${tool}`);
      }
    },
  };
}
