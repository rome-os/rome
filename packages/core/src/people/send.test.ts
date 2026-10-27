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
      { platform: "unknown", id: "u" },
      ...channels.map((c) => ({ platform: c.name, id: "u" })),
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

describe("a link on a platform Rome holds accounts on", () => {
  const open = (name: string) => channel(name, sending({ chatFor: async (id) => id as ChatId }));
  const unbacked = (name: string) =>
    channel(name, sending({ chatFor: () => Promise.reject(new ChannelNotConnected(name)) }));
  const link = { platform: "telegram", id: "u" };
  const platformOfChannel = (name: string) => (name.startsWith("tg-") ? "telegram" : name);

  it("sends on a platform's own channel exactly as on any other", async () => {
    const resolution = await resolveSendTarget({ channels: [open("telegram")] }, link);
    expect(resolution.ok && resolution.target.channel).toBe("telegram");
  });

  it("sends from Rome's only account on the platform, whatever its channel is called", async () => {
    // The connection kind's own channel is always listed, backed or not.
    const deps = {
      channels: [unbacked("telegram"), open("tg-opaque")],
      platformOfChannel,
      sendersOn: (platform: string) => (platform === "telegram" ? ["tg-opaque"] : null),
    };

    expect(await readSendStates(deps, [link])).toEqual(["yes"]);
    const resolution = await resolveSendTarget(deps, link);
    expect(resolution.ok && resolution.target.channel).toBe("tg-opaque");
  });

  it("sends from none of several accounts unless the send names one", async () => {
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
      platformOfChannel,
      sendersOn: (platform: string) =>
        platform === "telegram" ? ["tg-opaque", "tg-second"] : null,
    };

    expect(await resolveSendTarget(deps, link)).toEqual({ ok: false, send: "not-connected" });
    expect(asked).toBe(0);
    const named = await resolveSendTarget(deps, link, "tg-second");
    expect(named.ok && named.target.channel).toBe("tg-second");
    // Either account can reach the person, so the person reads as sendable.
    expect(await readSendStates(deps, [link])).toEqual(["yes"]);
  });

  it("reads as not connected while Rome holds no account on the platform", async () => {
    const deps = {
      channels: [open("telegram")],
      sendersOn: (platform: string) => (platform === "telegram" ? [] : null),
    };

    expect(await readSendStates(deps, [link])).toEqual(["not-connected"]);
  });
});
