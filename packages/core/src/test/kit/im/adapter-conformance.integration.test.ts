// Every chat adapter against its platform's peer, through the conformance
// suite (./adapter-conformance.ts).

import { rs } from "@rstest/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelOver, describeAdapterConformance } from "./adapter-conformance.js";
import { DISCORD_DM, DISCORD_USER, DiscordPeer } from "./discord.js";
import { FEISHU_BOT, FEISHU_CHAT, FEISHU_P2P, FEISHU_USER, FeishuPeer } from "./feishu.js";
import { EMAIL_MAILBOX, EmailPeer } from "./email.js";
import { TELEGRAM_CHAT, TelegramPeer } from "./telegram.js";
import { WECHAT_USER, WechatPeer } from "./wechat.js";

// Feishu: the app hears a person in their p2p chat (`oc_…`), and reaches
// them there or at their open id (`ou_…`).
describeAdapterConformance(
  "Feishu",
  async () => {
    const peer = await FeishuPeer.start();
    const adapter = peer.createAdapter();
    const channel = channelOver("feishu", "00000000-0000-4000-8000-000000000001", adapter);
    await adapter.start();
    return {
      account: { platform: "feishu", id: FEISHU_BOT },
      channel,
      direct: {
        person: FEISHU_USER,
        at: FEISHU_P2P,
        personWrites: (text) => peer.emitMessage(text).id,
      },
      // A group message reaches Rome when it names the bot, as Feishu groups
      // require by default.
      group: {
        at: FEISHU_CHAT,
        personWrites: (text) => peer.emitMessage(text, FEISHU_CHAT, { mentionsBot: true }).id,
      },
      visible: (at) => peer.visible(at),
      stop: async () => {
        await adapter.stop();
        await peer.close();
        peer.server.assertClean();
      },
    };
  },
  { directMessages: true, romeWritesFirst: true, groups: true },
);

// Discord: the bot hears a person in their DM channel, and reaches them there
// or by their user id, which opens the DM. The person's first DM reaches the
// bot with no DM opened before it; the peer's gateway frame for it is
// synthetic until a recording covers it.
describeAdapterConformance(
  "Discord",
  async () => {
    const peer = await DiscordPeer.start();
    const adapter = peer.createAdapter();
    const channel = channelOver("discord", "00000000-0000-4000-8000-000000000002", adapter);
    await adapter.start();
    await peer.server.waitFor((e) => e.request.path.endsWith("/commands") && !!e.response);
    return {
      account: { platform: "discord", id: "100000000000000001" },
      channel,
      direct: {
        person: DISCORD_USER,
        at: DISCORD_DM,
        personWrites: (text) => peer.emitMessage(text).id,
      },
      visible: (at) => peer.visible(at),
      stop: async () => {
        await adapter.stop();
        await peer.close();
        peer.server.assertClean();
      },
    };
  },
  { directMessages: true, romeWritesFirst: true, groups: false },
);

// Telegram: the bot hears a person in their private chat, whose id is the
// person's own, and reaches them there. The peer models private chats only.
describeAdapterConformance(
  "Telegram",
  async () => {
    const peer = await TelegramPeer.start();
    const adapter = peer.createAdapter();
    const channel = channelOver("telegram", "00000000-0000-4000-8000-000000000003", adapter);
    await adapter.start();
    const person = String(TELEGRAM_CHAT);
    return {
      account: { platform: "telegram", id: "telegram-bot" },
      channel,
      direct: { person, at: person, personWrites: (text) => peer.emitMessage(text).id },
      visible: (at) => peer.visible(at),
      stop: async () => {
        await adapter.stop();
        await peer.close();
        peer.server.assertClean();
      },
    };
  },
  { directMessages: true, romeWritesFirst: true, groups: false },
);

// WeChat: the bot hears a person by their user id and answers there, with the
// context token their message carried. WeChat has no groups for a bot.
describeAdapterConformance(
  "WeChat",
  async () => {
    const peer = await WechatPeer.start();
    rs.stubGlobal("fetch", peer.fetch);
    const statePath = await mkdtemp(join(tmpdir(), "wechat-conformance-"));
    const adapter = peer.createAdapter(statePath);
    const channel = channelOver("wechat", "00000000-0000-4000-8000-000000000004", adapter);
    await adapter.start();
    return {
      account: { platform: "wechat", id: "fixture-bot" },
      channel,
      direct: {
        person: WECHAT_USER,
        at: WECHAT_USER,
        personWrites: (text) => peer.emitMessage(text).id,
      },
      visible: (at) => peer.visible(at),
      stop: async () => {
        await adapter.stop();
        await peer.close();
        await rm(statePath, { recursive: true, force: true });
        rs.unstubAllGlobals();
        peer.server.assertClean();
      },
    };
  },
  { directMessages: true, romeWritesFirst: false, groups: false },
);

// Email: a thread is a group chat, and there are no direct messages. The
// person writes in a thread, and Rome answers on it.
describeAdapterConformance(
  "Email",
  async () => {
    const peer = new EmailPeer();
    await peer.adapter.start();
    const channel = channelOver("email", "00000000-0000-4000-8000-000000000005", peer.adapter);
    return {
      account: { platform: "email", id: EMAIL_MAILBOX },
      channel,
      group: { at: "thread-g", personWrites: (text) => peer.personWrites(text, "thread-g") },
      visible: (at) => peer.visible(at),
      stop: () => peer.adapter.stop(),
    };
  },
  { directMessages: false, romeWritesFirst: false, groups: true },
);
