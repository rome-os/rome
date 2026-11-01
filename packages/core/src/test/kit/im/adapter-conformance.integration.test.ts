// Every chat adapter against its platform's peer, through the conformance
// suite (./adapter-conformance.ts).

import { rs } from "@rstest/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelOver, describeAdapterConformance } from "./adapter-conformance.js";
import {
  DISCORD_CHANNEL,
  DISCORD_DM,
  DISCORD_SECOND_BOT_ID,
  DISCORD_SECOND_TOKEN,
  DISCORD_THREAD,
  DISCORD_USER,
  DiscordPeer,
} from "./discord.js";
import {
  FEISHU_BOT,
  FEISHU_CHAT,
  FEISHU_P2P,
  FEISHU_SECOND_APP_ID,
  FEISHU_SECOND_BOT,
  FEISHU_USER,
  FeishuPeer,
} from "./feishu.js";
import { EMAIL_MAILBOX, EmailPeer } from "./email.js";
import { TELEGRAM_CHAT, TELEGRAM_GROUP, TELEGRAM_SECOND_TOKEN, TelegramPeer } from "./telegram.js";
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
    // A second of Rome's accounts, a second app in the same group. Feishu
    // pushes a group message to every app in the group under the one id.
    const second = peer.createAdapter(FEISHU_SECOND_APP_ID);
    await second.start();
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
      second: {
        account: { platform: "feishu", id: FEISHU_SECOND_BOT },
        channel: channelOver("feishu-2", "00000000-0000-4000-8000-000000000006", second),
        bothHear: (text) => peer.emitMessage(text, FEISHU_CHAT, { mentionsEveryBot: true }).id,
      },
      visible: (at) => peer.visible(at),
      stop: async () => {
        await second.stop();
        await adapter.stop();
        await peer.close();
        peer.server.assertClean();
      },
    };
  },
  { directMessages: true, romeWritesFirst: true, groups: true, twoAccounts: true, threads: false },
);

// Discord: the bot hears a person in their DM channel, and reaches them there
// or by their user id, which opens the DM. The person's first DM reaches the
// bot with no DM opened before it; the peer's gateway frame for it is
// synthetic until a recording covers it.
describeAdapterConformance(
  "Discord",
  async () => {
    const peer = await DiscordPeer.start({ guild: true });
    const adapter = peer.createAdapter();
    const channel = channelOver("discord", "00000000-0000-4000-8000-000000000002", adapter);
    await adapter.start();
    await peer.server.waitFor((e) => e.request.path.endsWith("/commands") && !!e.response);
    // A second of Rome's accounts, a second bot in the guild. Discord gives a
    // message one id whichever bot reads it.
    const second = peer.createAdapter(DISCORD_SECOND_TOKEN);
    await second.start();
    return {
      account: { platform: "discord", id: "100000000000000001" },
      channel,
      direct: {
        person: DISCORD_USER,
        at: DISCORD_DM,
        personWrites: (text) => peer.emitMessage(text).id,
      },
      // The guild's text channel is a group; a guild message names the bot.
      group: {
        at: DISCORD_CHANNEL,
        personWrites: (text) => peer.emitMessage(text, DISCORD_CHANNEL).id,
      },
      thread: {
        at: DISCORD_THREAD,
        personWrites: (text) => peer.emitMessage(text, DISCORD_THREAD).id,
      },
      second: {
        account: { platform: "discord", id: DISCORD_SECOND_BOT_ID },
        channel: channelOver("discord-2", "00000000-0000-4000-8000-000000000007", second),
        bothHear: (text) => peer.emitMessage(text, DISCORD_CHANNEL, { mentionsEveryBot: true }).id,
      },
      visible: (at) => peer.visible(at),
      stop: async () => {
        await second.stop();
        await adapter.stop();
        await peer.close();
        peer.server.assertClean();
      },
    };
  },
  { directMessages: true, romeWritesFirst: true, groups: true, twoAccounts: true, threads: true },
);

// Telegram: the bot hears a person in their private chat, whose id is the
// person's own, and reaches them there.
describeAdapterConformance(
  "Telegram",
  async () => {
    const peer = await TelegramPeer.start();
    const adapter = peer.createAdapter();
    const channel = channelOver("telegram", "00000000-0000-4000-8000-000000000003", adapter);
    await adapter.start();
    // A second of Rome's accounts, a second bot in the same supergroup.
    const second = peer.createAdapter(TELEGRAM_SECOND_TOKEN);
    await second.start();
    const person = String(TELEGRAM_CHAT);
    const group = String(TELEGRAM_GROUP);
    return {
      account: { platform: "telegram", id: "telegram-bot" },
      channel,
      direct: { person, at: person, personWrites: (text) => peer.emitMessage(text).id },
      // Both bots are the group's admins, so each hears every message in it.
      group: {
        at: group,
        personWrites: (text) => peer.emitMessage(text, TELEGRAM_GROUP).id,
      },
      second: {
        account: { platform: "telegram", id: "telegram-bot-2" },
        channel: channelOver("telegram-2", "00000000-0000-4000-8000-000000000008", second),
        bothHear: (text) => peer.emitMessage(text, TELEGRAM_GROUP).id,
      },
      visible: (at) => peer.visible(at),
      stop: async () => {
        await second.stop();
        await adapter.stop();
        await peer.close();
        peer.server.assertClean();
      },
    };
  },
  { directMessages: true, romeWritesFirst: true, groups: true, twoAccounts: true, threads: false },
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
  {
    directMessages: true,
    romeWritesFirst: false,
    groups: false,
    twoAccounts: false,
    threads: false,
  },
);

// Email: a thread is a group chat, and there are no direct messages. The
// person writes in a thread, and Rome answers on it. Two of Rome's mailboxes
// on one email each hold their own copy, under their own thread and message
// ids, so the adapter reads them as two threads and the two-account case does
// not apply.
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
  {
    directMessages: false,
    romeWritesFirst: false,
    groups: true,
    twoAccounts: false,
    threads: false,
  },
);
