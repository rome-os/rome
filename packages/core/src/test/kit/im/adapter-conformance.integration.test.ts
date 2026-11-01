// Every chat adapter against its platform's peer, through the conformance
// suite (./adapter-conformance.ts).

import { channelOver, describeAdapterConformance } from "./adapter-conformance.js";
import { DISCORD_DM, DISCORD_USER, DiscordPeer } from "./discord.js";
import { FEISHU_BOT, FEISHU_P2P, FEISHU_USER, FeishuPeer } from "./feishu.js";

// Feishu: the app hears a person in their p2p chat (`oc_…`), and reaches
// them there or at their open id (`ou_…`).
describeAdapterConformance("Feishu", async () => {
  const peer = await FeishuPeer.start();
  const adapter = peer.createAdapter();
  const channel = channelOver("feishu", "00000000-0000-4000-8000-000000000001", adapter);
  await adapter.start();
  return {
    account: { platform: "feishu", id: FEISHU_BOT },
    channel,
    person: FEISHU_USER,
    dm: FEISHU_P2P,
    personWrites: (text) => void peer.emitMessage(text),
    visible: (at) => peer.visible(at),
    stop: async () => {
      await adapter.stop();
      await peer.close();
      peer.server.assertClean();
    },
  };
});

// Discord: the bot hears a person in their DM channel, and reaches them there
// or by their user id, which opens the DM. The person's first DM reaches the
// bot with no DM opened before it; the peer's gateway frame for it is
// synthetic until a recording covers it.
describeAdapterConformance("Discord", async () => {
  const peer = await DiscordPeer.start();
  const adapter = peer.createAdapter();
  const channel = channelOver("discord", "00000000-0000-4000-8000-000000000002", adapter);
  await adapter.start();
  await peer.server.waitFor((e) => e.request.path.endsWith("/commands") && !!e.response);
  return {
    account: { platform: "discord", id: "100000000000000001" },
    channel,
    person: DISCORD_USER,
    dm: DISCORD_DM,
    personWrites: (text) => void peer.emitMessage(text),
    visible: (at) => peer.visible(at),
    stop: async () => {
      await adapter.stop();
      await peer.close();
      peer.server.assertClean();
    },
  };
});
