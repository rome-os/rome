import { createAppLogger } from "@rome-os/app-runtime";
import type { Action, ActionConfig, ActionResult, ChannelsService } from "@rome-os/app-runtime";

const log = createAppLogger("find_channel_account");

export function createAction(
  config: ActionConfig,
  deps: { channelsService: Pick<ChannelsService, "accounts"> },
): Action {
  const { channelsService: channels } = deps;

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description:
            'Channel name, e.g. "agents" for agents on Rome Cloud, such as the guardian\'s dots and the agents of linked accounts.',
        },
        query: {
          type: "string",
          description: "Part of a name or address to match. Omit to list the first accounts.",
        },
        limit: {
          type: "number",
          description: "How many accounts to return (default 20, at most 100).",
        },
      },
      required: ["channel"],
    },

    async execute(args): Promise<ActionResult> {
      const channel = args.channel as string;
      const query = args.query as string | undefined;
      const limit = Math.min(
        Math.max(Math.floor((args.limit as number | undefined) ?? 20), 1),
        100,
      );

      try {
        const accounts = await channels.accounts(channel, { ...(query ? { query } : {}), limit });
        return { status: "ok", data: { channel, accounts } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("account lookup failed", { channel, error: message });
        return { status: "error", error: `Could not look up accounts on "${channel}": ${message}` };
      }
    },
  };
}
