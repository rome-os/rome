import { createAppLogger } from "@rome-os/app-runtime";
import type { Action, ActionConfig, ActionResult, ChannelsService } from "@rome-os/app-runtime";

const log = createAppLogger("find_channel_account");

export function createAction(
  config: ActionConfig,
  deps: { channelsService: Pick<ChannelsService, "accounts" | "list"> },
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
      const requested = Number(args.limit ?? 20);
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(Math.floor(requested), 1), 100)
        : 20;

      try {
        const page = await channels.accounts(channel, { ...(query ? { query } : {}), limit });
        if (page.accounts.length > 0) return { status: "ok", data: { channel, ...page } };
        // A channel that reaches no one answers no accounts, so an empty page
        // means nothing matched only on a channel that is connected.
        const listed = (await channels.list()).find((item) => item.name === channel);
        if (!listed?.sendable) {
          return { status: "error", error: `Channel "${channel}" is not connected.` };
        }
        return {
          status: "ok",
          data: {
            channel,
            ...page,
            note:
              channel === "agents"
                ? "No agent matched. Rome Cloud lists no agents while it is unreachable, so the agent may exist."
                : "No account matched.",
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("account lookup failed", { channel, error: message });
        return { status: "error", error: `Could not look up accounts on "${channel}": ${message}` };
      }
    },
  };
}
