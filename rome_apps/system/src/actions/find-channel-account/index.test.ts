import { describe, it, expect } from "@rstest/core";
import { createAction, type ChannelAccountsService } from "./index.js";

const actionConfig = {
  name: "find_channel_account",
  type: "system",
  description: "Find who a channel can reach",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
} as const;

const atlas = {
  name: "atlas (dot)",
  addresses: ["0b6f6f8e-8a4c-4f3e-9c9d-2f1a3b4c5d6e"],
};

type Page = { accounts: (typeof atlas)[]; more: boolean };

function makeAction(
  find: (channel: string, read?: { query?: string; limit?: number }) => Promise<Page>,
  connected = true,
) {
  const channelAccounts: ChannelAccountsService = {
    find: async (channel, read) => ({ connected, ...(await find(channel, read)) }),
  };
  return createAction(actionConfig, { channelAccounts });
}

describe("find_channel_account", () => {
  it("returns the accounts the channel matches, with the address send_message takes", async () => {
    const calls: unknown[] = [];
    const action = makeAction(async (channel, read) => {
      calls.push({ channel, read });
      return { accounts: [atlas], more: true };
    });

    const result = await action.execute({ channel: "agents", query: "atlas" });

    expect(result).toEqual({
      status: "ok",
      data: { channel: "agents", connected: true, accounts: [atlas], more: true },
    });
    expect(calls).toEqual([{ channel: "agents", read: { query: "atlas" } }]);
  });

  it("passes a numeric limit to core to clamp, and drops one that is not a number", async () => {
    const limits: (number | undefined)[] = [];
    const action = makeAction(async (_channel, read) => {
      limits.push(read?.limit);
      return { accounts: [atlas], more: false };
    });

    await action.execute({ channel: "agents", limit: 500 });
    await action.execute({ channel: "agents", limit: 0 });
    await action.execute({ channel: "agents", limit: "many" });
    await action.execute({ channel: "agents", limit: null });

    expect(limits).toEqual([500, 0, undefined, undefined]);
  });

  it("says an agent may exist when a connected channel matches no one", async () => {
    const action = makeAction(async () => ({ accounts: [], more: false }));

    const result = await action.execute({ channel: "agents", query: "atlas" });

    expect(result).toMatchObject({ status: "ok", data: { accounts: [], more: false } });
    expect(result.status === "ok" && result.data).toHaveProperty(
      "note",
      expect.stringContaining("Rome Cloud lists no agents while it is unreachable"),
    );
  });

  it("reports a channel nothing connects as not connected, not as no match", async () => {
    const action = makeAction(async () => ({ accounts: [], more: false }), false);

    const result = await action.execute({ channel: "agents", query: "atlas" });

    expect(result).toEqual({ status: "error", error: 'Channel "agents" is not connected.' });
  });

  it("returns what a channel that is not connected still lists, saying so", async () => {
    const action = makeAction(async () => ({ accounts: [atlas], more: false }), false);

    const result = await action.execute({ channel: "agents" });

    expect(result).toMatchObject({ status: "ok", data: { connected: false, accounts: [atlas] } });
  });

  it("reports a channel the service cannot search as an error", async () => {
    const action = makeAction(async (channel) => {
      throw new Error(`Unknown channel "${channel}"`);
    });

    const result = await action.execute({ channel: "agent" });

    expect(result).toEqual({
      status: "error",
      error: 'Could not look up accounts on "agent": Unknown channel "agent"',
    });
  });
});
