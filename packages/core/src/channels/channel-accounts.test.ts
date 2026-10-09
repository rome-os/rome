import { describe, expect, it, rs } from "@rstest/core";
import type { Channels } from "./channel.js";
import { createChannelAccounts } from "./channel-accounts.js";
import type { Connection } from "../connections/types.js";

// The system-only lookup send_message resolves agent names with, over each channel's
// address book.

const atlas = {
  id: "a1",
  name: "atlas (dot)",
  addresses: ["a1"],
  identifiers: { "agents:id": "a1" },
};

function lookup(talk: "unlocked" | "needs-auth" | null, nextCursor?: string) {
  const listAccounts = rs.fn(async (_input: { query?: string; limit: number }) => ({
    accounts: [atlas],
    nextCursor,
  }));
  const connections = talk
    ? [{ id: "agents-1", service: "agents", status: () => ({ talk: { state: talk } }) }]
    : [];
  const channelAccounts = createChannelAccounts({
    channels: () =>
      [
        { name: "agents", accounts: { listAccounts, resolve: async () => null } },
        { name: "discord", accounts: null },
      ] as unknown as Channels,
    registry: { all: () => connections as unknown as Connection[] },
  });
  return { channelAccounts, listAccounts };
}

describe("createChannelAccounts", () => {
  it("answers each account's name and addresses, and whether more matched", async () => {
    const { channelAccounts, listAccounts } = lookup("unlocked", "1");

    expect(await channelAccounts.find("agents", { query: "atlas" })).toEqual({
      connected: true,
      accounts: [{ name: "atlas (dot)", addresses: ["a1"] }],
      more: true,
    });
    expect(listAccounts).toHaveBeenCalledWith({ query: "atlas", limit: 20 });
  });

  it("keeps the limit within the cap in the main process as over RPC", async () => {
    const { channelAccounts, listAccounts } = lookup("unlocked");

    await channelAccounts.find("agents", { limit: 10_000 });
    await channelAccounts.find("agents", { limit: 0 });
    await channelAccounts.find("agents", { limit: Number.NaN });

    expect(listAccounts.mock.calls.map(([input]) => input.limit)).toEqual([100, 1, 20]);
  });

  it("says the channel is not connected while its Connection is locked or absent", async () => {
    expect((await lookup("needs-auth").channelAccounts.find("agents")).connected).toBe(false);
    expect((await lookup(null).channelAccounts.find("agents")).connected).toBe(false);
  });

  it("says so while the channel list is still being built", async () => {
    const early = createChannelAccounts({ channels: () => undefined, registry: { all: () => [] } });

    await expect(early.find("agents")).rejects.toThrow("Channels are still starting");
  });

  it("refuses an unknown channel and one with no address book", async () => {
    const { channelAccounts } = lookup("unlocked");

    await expect(channelAccounts.find("agent")).rejects.toThrow('Unknown channel "agent"');
    await expect(channelAccounts.find("discord")).rejects.toThrow(
      'Channel "discord" has no address book',
    );
  });
});
