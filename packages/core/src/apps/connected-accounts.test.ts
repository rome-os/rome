import { describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage } from "@rome-os/app-runtime";
import { createConnectedAccounts } from "./connected-accounts.js";

describe("createConnectedAccounts", () => {
  it("lists every account with its profile name and agent, a disconnected one as disconnected", async () => {
    const accounts = createConnectedAccounts({
      rows: () => [
        {
          platform: "telegram",
          accountId: "bot-1",
          agent: "core:main",
          connectionId: "c1",
          name: "Rome",
        },
        {
          platform: "slack",
          accountId: "U1",
          agent: "app:helper",
          connectionId: null,
          name: "stale",
        },
      ],
      names: async (listed) =>
        listed.map((account) => (account.id === "bot-1" ? "Rome bot" : null)),
      query: async () => [],
    });

    expect(await accounts.list()).toEqual([
      {
        account: { platform: "telegram", id: "bot-1" },
        name: "Rome bot",
        agent: "core:main",
        connected: true,
      },
      {
        account: { platform: "slack", id: "U1" },
        name: null,
        agent: "app:helper",
        connected: false,
      },
    ]);
  });

  it("reads what was said through an account by its platform and id", async () => {
    const said = [{ messageId: "m" } as ChannelMessage];
    const query = rs.fn(async () => said);
    const accounts = createConnectedAccounts({ rows: () => [], names: async () => [], query });

    expect(await accounts.query({ platform: "telegram", id: "bot-1" }, { limit: 2 })).toBe(said);
    expect(query).toHaveBeenCalledWith({ platform: "telegram", id: "bot-1" }, { limit: 2 });
  });
});
