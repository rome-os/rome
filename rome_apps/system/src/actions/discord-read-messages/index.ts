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
        channelId: {
          type: "string",
          description:
            "The Discord channel or thread id. Defaults to the one this run was woken in.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "How many messages, at most 100. Default 50.",
        },
        before: { type: "string", description: "Read the messages before this message id." },
        after: { type: "string", description: "Read the messages after this message id." },
      },
      required: [],
    },
    execute(args): Promise<ActionResult> {
      return runConnectionTool(deps.channelsService, "discord_read_messages", args, "channelId");
    },
  };
}
