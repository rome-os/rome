import { describe, expect, it } from "@rstest/core";
import type { ChatId, ChannelDirectMessaging } from "@rome-os/app-runtime";
import { type Channel, ChannelNotConnected, type ChannelSend } from "../channels/channel.js";
import { readSendStates, resolveSendTarget } from "./send.js";

function channel(name: string, send: ChannelSend | null): Channel {
  return { name, send, inbound: null, accounts: null, messages: null, directory: null };
}

function sending(talker: Pick<ChannelDirectMessaging, "chatFor"> | null): ChannelSend {
  const direct = talker && { ...talker, conversationFor: talker.chatFor };
  return { send: async (chatId) => ({ chatId }), direct, activity: null };
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

describe("a link keyed by a connection kind", () => {
  const open = (name: string) => channel(name, sending({ chatFor: async (id) => id as ChatId }));
  const unbacked = (name: string) =>
    channel(name, sending({ chatFor: () => Promise.reject(new ChannelNotConnected(name)) }));
  const link = { channel: "telegram", channelUserId: "u" };

  it("sends on the kind's own channel exactly as on any other", async () => {
    const resolution = await resolveSendTarget({ channels: [open("telegram")] }, link);
    expect(resolution.ok && resolution.target.channel).toBe("telegram");
  });

  it("sends on the kind's only account when its id is opaque", async () => {
    // The connection kind's own channel is always listed, backed or not.
    const deps = {
      channels: [unbacked("telegram"), open("tg-opaque")],
      channelOfLink: (linked: string) => (linked === "telegram" ? "tg-opaque" : linked),
    };

    expect(await readSendStates(deps, [link])).toEqual(["yes"]);
    const resolution = await resolveSendTarget(deps, link);
    expect(resolution.ok && resolution.target.channel).toBe("tg-opaque");
  });

  it("sends on none of several accounts, and asks none of them", async () => {
    let asked = 0;
    const counted = (name: string) =>
      channel(
        name,
        sending({
          chatFor: async (id) => {
            asked++;
            return id as ChatId;
          },
        }),
      );
    const deps = {
      channels: [counted("tg-opaque"), counted("tg-second")],
      channelOfLink: (linked: string) => (linked === "telegram" ? null : linked),
    };

    expect(await readSendStates(deps, [link])).toEqual(["not-connected"]);
    expect(asked).toBe(0);
    // A link naming one account's own id still reaches it.
    const exact = await resolveSendTarget(deps, { channel: "tg-second", channelUserId: "u" });
    expect(exact.ok && exact.target.channel).toBe("tg-second");
  });
});
