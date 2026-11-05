import type { Action, ActionConfig, ActionResult, ChannelsService } from "@rome-os/app-runtime";
import { runConnectionTool } from "../connection-tool.js";

export function createAction(
  config: ActionConfig,
  deps: { channelsService: ChannelsService },
): Action {
  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "The account's channel. Defaults to the one this run was woken on.",
        },
        chatId: {
          type: "string",
          description: "The Telegram chat id. Defaults to the one this run was woken in.",
        },
        messageId: { type: "string", description: "The message to react to." },
        emoji: {
          type: "string",
          description:
            "One of Telegram's reaction emoji, such as 👍 ❤ 🔥 🎉 👀. Empty takes the reaction back.",
        },
      },
      required: [],
    },
    execute(args): Promise<ActionResult> {
      return runConnectionTool(deps.channelsService, "telegram_react", args, "chatId");
    },
  };
}
