import { createAppLogger } from "@rome-os/app-runtime";
import type { Action, ActionConfig, ActionResult } from "@rome-os/app-runtime";

const log = createAppLogger("find_channel_account");

/** Core's address-book lookup, handed to the system app alone. Declared here
 *  because an app cannot import core, and a worker receives a proxy. */
export interface ChannelAccountsService {
  find(
    channel: string,
    read?: { query?: string; limit?: number },
  ): Promise<{
    connected: boolean;
    accounts: { name: string | null; addresses: string[] }[];
    more: boolean;
  }>;
}

export function createAction(
  config: ActionConfig,
  deps: { channelAccounts?: ChannelAccountsService },
): Action {
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
      const { channelAccounts } = deps;
      if (!channelAccounts) {
        return { status: "error", error: "Account lookup is not available in this Rome." };
      }
      const channel = args.channel as string;
      const query = args.query as string | undefined;
      const requested = Number(args.limit ?? 20);

      try {
        const found = await channelAccounts.find(channel, {
          ...(query ? { query } : {}),
          ...(Number.isFinite(requested)
            ? { limit: Math.min(Math.max(Math.floor(requested), 1), 100) }
            : {}),
        });
        // A channel that is not connected lists no one, so its empty answer
        // would read as nobody matching.
        if (!found.connected && found.accounts.length === 0) {
          return { status: "error", error: `Channel "${channel}" is not connected.` };
        }
        const data = { channel, accounts: found.accounts, more: found.more };
        if (found.accounts.length > 0) return { status: "ok", data };
        return {
          status: "ok",
          data: {
            ...data,
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
