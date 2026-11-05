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
        messageId: { type: "string", description: "The message to react to." },
        emoji: { type: "string", description: "A Unicode emoji, or a server emoji as name:id." },
      },
      required: [],
    },
    execute(args): Promise<ActionResult> {
      return runConnectionTool(deps.channelsService, "discord_react", args, "channelId");
    },
  };
}
