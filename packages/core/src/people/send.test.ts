import { describe, expect, it } from "@rstest/core";
import type { ChatId, ChannelDirectMessaging } from "@rome-os/app-runtime";
import { type Channel, ChannelNotConnected, type ChannelSend } from "../channels/channel.js";
import { readSendStates } from "./send.js";

function channel(name: string, send: ChannelSend | null): Channel {
  return { name, send, inbound: null, accounts: null, messages: null, directory: null };
}

function sending(direct: ChannelDirectMessaging | null): ChannelSend {
  return { send: async (conversationId) => ({ conversationId }), direct, activity: null };
}

describe("readSendStates", () => {
  it("answers each state from the channel's send port", async () => {
    const channels = [
      channel(
        "unbacked",
        sending({
          chatFor: () => Promise.reject(new ChannelNotConnected("unbacked")),
        }),
      ),
      channel("read-only", null),
      channel("no-direct", sending(null)),
      channel("no-thread", sending({ chatFor: async () => null })),
      channel(
        "down",
        sending({
          chatFor: () => Promise.reject(new Error("provider is down")),
        }),
      ),
      channel("open", sending({ chatFor: async (id) => id as ChatId })),
    ];

    const states = await readSendStates({ channels }, [
      { channel: "unknown", channelUserId: "u" },
      ...channels.map((c) => ({ channel: c.name, channelUserId: "u" })),
    ]);

    expect(states).toEqual([
      "not-connected",
      "not-connected",
      "unsupported",
      "unsupported",
      "no-conversation",
      "no-conversation",
      "yes",
    ]);
  });
});
