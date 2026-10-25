import { describe, expect, it } from "@rstest/core";
import type { Channels } from "../channels/channel.js";
import { linkReach, type ReachDeps } from "./link-reach.js";

// Reach is read for every link on the People listing, so what it costs per
// link decides what the listing costs.

const channels = [{ name: "telegram" }, { name: "telegram_user" }, { name: "whatsapp" }];

function countingDeps() {
  const calls = { recorded: 0, platform: 0, holder: 0 };
  const deps: ReachDeps = {
    channels: channels as unknown as Channels,
    recordedChannels: () => {
      calls.recorded++;
      return ["telegram_2"];
    },
    platformOfChannel: (name) => {
      calls.platform++;
      return name.startsWith("telegram") ? "telegram" : name;
    },
    personMappingRepo: {
      findByChannelUser: async () => {
        calls.holder++;
        return null;
      },
      linkKeyOf: (channel) => (channel === "telegram_2" ? "telegram" : channel),
    },
  };
  return { deps, calls };
}

describe("linkReach", () => {
  it("reads channels and platforms once for a listing, and holders from its snapshot", async () => {
    const { deps, calls } = countingDeps();
    const everyone = Array.from({ length: 50 }, (_, i) => ({
      id: `p${i}`,
      channelMappings: [{ channel: "telegram", channelUserId: String(i) }],
    }));
    const reach = linkReach(deps, everyone);

    for (const person of everyone) await reach.ofAll(person);

    expect(calls).toEqual({ recorded: 1, platform: 4, holder: 0 });
  });

  it("reaches the platform's other channels, recorded ones included", async () => {
    const { deps } = countingDeps();

    const reach = await linkReach(deps).of("mei", { channel: "telegram", channelUserId: "1" });

    expect(reach.map((address) => address.channel)).toEqual([
      "telegram",
      "telegram_user",
      "telegram_2",
    ]);
  });

  it("leaves out an address another person holds, read from the snapshot", async () => {
    const { deps } = countingDeps();
    const everyone = [
      { id: "mei", channelMappings: [{ channel: "telegram", channelUserId: "1" }] },
      { id: "bo", channelMappings: [{ channel: "telegram_user", channelUserId: "1" }] },
    ];

    const reach = await linkReach(deps, everyone).ofAll(everyone[0]!);

    // telegram_2 files its links under telegram, which is Mei's own.
    expect(reach.map((address) => address.channel)).toEqual(["telegram", "telegram_2"]);
  });
});
