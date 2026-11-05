// The platforms the eval runs, each a production adapter against its
// platform's peer. Set up exactly as the conformance suite sets them up
// (../../adapter-conformance.integration.test.ts), copied here so the eval
// stays off main and needs no change there.

import { rs } from "@rstest/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelOver, type ConformanceChannel } from "../../kit/im/adapter-conformance.js";
import { exemplar, loadCapture } from "../../kit/im/capture.js";
import wechatTextCapture from "../../kit/im/captures/wechat-text.capture.json" with {
  type: "json",
};
import {
  DISCORD_CHANNEL,
  DISCORD_DM,
  DISCORD_SECOND_BOT_ID,
  DISCORD_SECOND_TOKEN,
  DISCORD_THREAD,
  DISCORD_USER,
  DiscordPeer,
} from "../../kit/im/discord.js";
import {
  FEISHU_BOT,
  FEISHU_CHAT,
  FEISHU_P2P,
  FEISHU_SECOND_APP_ID,
  FEISHU_SECOND_BOT,
  FEISHU_USER,
  FeishuPeer,
} from "../../kit/im/feishu.js";
import { EMAIL_MAILBOX, EmailPeer } from "../../kit/im/email.js";
import {
  TELEGRAM_CHAT,
  TELEGRAM_GROUP,
  TELEGRAM_SECOND_TOKEN,
  TELEGRAM_TOKEN,
  TelegramPeer,
} from "../../kit/im/telegram.js";
import { WECHAT_USER, WechatPeer } from "../../kit/im/wechat.js";

const wechatCapture = loadCapture(wechatTextCapture);

/** What a platform has and its peer models. */
export interface Models {
  directMessages: boolean;
  romeWritesFirst: boolean;
  groups: boolean;
  twoAccounts: boolean;
  threads: boolean;
}

export interface EvalPlatform {
  readonly name: string;
  readonly start: () => Promise<ConformanceChannel>;
  readonly models: Models;
}

/** Every platform the eval runs, in the order the scorecard lists them. */
export const PLATFORMS: EvalPlatform[] = [];

// The conformance suite's gap list is not used: the eval reports what fails.
function platform(
  name: string,
  start: () => Promise<ConformanceChannel>,
  models: Models,
  _gaps?: unknown,
): void {
  PLATFORMS.push({ name, start, models });
}

// Feishu: the app hears a person in their p2p chat (`oc_…`), and reaches
// them there or at their open id (`ou_…`).
platform(
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
      // Feishu refuses a post to a chat the bot is not in. The SDK sends the
      // message once more after its post is refused, and that is refused too.
      refuseNextSend: () => {
        for (let i = 0; i < 2; i++)
          peer.server.once({
            method: "POST",
            path: "/open-apis/im/v1/messages",
            respond: {
              status: 400,
              body: { code: 230002, msg: "Bot/User can NOT be out of the chat." },
            },
          });
      },
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
platform(
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
      // Discord refuses a message to a channel it does not know.
      refuseNextSend: () =>
        peer.server.once({
          method: "POST",
          path: `/api/v10/channels/${DISCORD_DM}/messages`,
          respond: { status: 404, body: { message: "Unknown Channel", code: 10003 } },
        }),
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
platform(
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
      // Telegram refuses a message to a chat it does not know. The adapter
      // retries a refused HTML message once as plain text, so both refuse.
      refuseNextSend: () => {
        for (let i = 0; i < 2; i++)
          peer.server.once({
            method: "POST",
            path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
            respond: {
              status: 400,
              body: { ok: false, error_code: 400, description: "Bad Request: chat not found" },
            },
          });
      },
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
platform(
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
      // iLink refuses a message to a recipient it cannot reach, as recorded.
      refuseNextSend: () =>
        peer.server.once({
          method: "POST",
          path: "/ilink/bot/sendmessage",
          respond: { status: 200, body: exemplar(wechatCapture, "send-invalid-recipient") },
        }),
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
platform(
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
      refuseNextSend: () => peer.refuseNextSend(),
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
