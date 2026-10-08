import { describe, expect, it } from "@rstest/core";
import type { ConversationId, TalkDirectMessaging } from "@rome-os/app-runtime";
import { type Channel, ChannelNotConnected, type ChannelSend } from "../channels/channel.js";
import { readSendStates } from "./send.js";

function channel(name: string, send: ChannelSend | null): Channel {
  return { name, send, inbound: null, accounts: null, messages: null, directory: null };
}

function sending(direct: TalkDirectMessaging | null): ChannelSend {
  return { send: async (conversationId) => ({ conversationId }), direct, activity: null };
}

describe("readSendStates", () => {
  it("answers each state from the channel's send port", async () => {
    const channels = [
      channel(
        "unbacked",
        sending({
          conversationFor: () => Promise.reject(new ChannelNotConnected("unbacked")),
        }),
      ),
      channel("read-only", null),
      channel("no-direct", sending(null)),
      channel("no-thread", sending({ conversationFor: async () => null })),
      channel(
        "down",
        sending({
          conversationFor: () => Promise.reject(new Error("provider is down")),
        }),
      ),
      channel("open", sending({ conversationFor: async (id) => id as ConversationId })),
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
