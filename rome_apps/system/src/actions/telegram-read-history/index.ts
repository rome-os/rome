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
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "How many messages, at most 200. Default 50.",
        },
        before: { type: "string", description: "Read the messages before this message id." },
      },
      required: [],
    },
    execute(args): Promise<ActionResult> {
      return runConnectionTool(deps.channelsService, "telegram_read_history", args, "chatId");
    },
  };
}
