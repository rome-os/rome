import { describe, it, expect } from "@rstest/core";
import type { ChannelAccount, ChannelsService } from "@rome-os/app-runtime";
import { createAction } from "./index.js";

const actionConfig = {
  name: "find_channel_account",
  type: "system",
  description: "Find who a channel can reach",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
} as const;

const atlas: ChannelAccount = {
  name: "atlas (dot)",
  addresses: ["0b6f6f8e-8a4c-4f3e-9c9d-2f1a3b4c5d6e"],
};

function makeAction(accounts: ChannelsService["accounts"]) {
  return createAction(actionConfig, { channelsService: { accounts } });
}

describe("find_channel_account", () => {
  it("returns the accounts the channel matches, with the address send_message takes", async () => {
    const calls: unknown[] = [];
    const action = makeAction(async (channel, read) => {
      calls.push({ channel, read });
      return [atlas];
    });

    const result = await action.execute({ channel: "agents", query: "atlas" });

    expect(result).toEqual({ status: "ok", data: { channel: "agents", accounts: [atlas] } });
    expect(calls).toEqual([{ channel: "agents", read: { query: "atlas", limit: 20 } }]);
  });

  it("keeps the limit within what the service accepts", async () => {
    const limits: (number | undefined)[] = [];
    const action = makeAction(async (_channel, read) => {
      limits.push(read?.limit);
      return [];
    });

    await action.execute({ channel: "agents", limit: 500 });
    await action.execute({ channel: "agents", limit: 0 });

    expect(limits).toEqual([100, 1]);
  });

  it("reports a channel with no address book as an error", async () => {
    const action = makeAction(async (channel) => {
      throw new Error(`Channel "${channel}" has no address book`);
    });

    const result = await action.execute({ channel: "webchat" });

    expect(result).toEqual({
      status: "error",
      error: 'Could not look up accounts on "webchat": Channel "webchat" has no address book',
    });
  });
});
