import { describe, expect, it } from "@rstest/core";
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
});
