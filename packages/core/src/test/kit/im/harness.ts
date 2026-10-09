import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChannelMessage,
  ConversationId,
  MessageReceipt,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import type { Client } from "discord.js";
import { DISCORD_DM, DiscordPeer } from "./discord.js";
import type { Peer } from "./peer.js";
import { TELEGRAM_CHAT, TelegramPeer } from "./telegram.js";
import { WECHAT_USER, WechatPeer } from "./wechat.js";

/**
 * A production adapter running against its platform's peer, with one
 * conversation open between Rome and a user. A scenario drives any platform
 * through this, so it never names one.
 */
export interface ChannelHarness {
  readonly platform: string;
  readonly peer: Peer;
  readonly conversation: ConversationId;
  /** Rome sends into the conversation through the adapter. */
  send(message: OutgoingMessage): Promise<MessageReceipt>;
  /** The user writes `text`; resolves with the message the adapter delivers. */
  receive(text: string): Promise<ChannelMessage>;
  stop(): Promise<void>;
}

interface Adapter {
  send(conversationId: ConversationId, message: OutgoingMessage): Promise<MessageReceipt>;
  onInbound(handler: (message: ChannelMessage) => Promise<void>): void;
  stop(): Promise<void>;
}

/** Hands each delivered message to the oldest waiting `receive`. */
function inbox(adapter: Adapter) {
  const waiting: Array<(message: ChannelMessage) => void> = [];
  adapter.onInbound(async (message) => waiting.shift()?.(message));
  return (emit: () => void) =>
    new Promise<ChannelMessage>((resolve) => {
      waiting.push(resolve);
      emit();
    });
}

async function telegram(): Promise<ChannelHarness> {
  const peer = await TelegramPeer.start();
  const adapter = peer.createAdapter();
  await adapter.start();
  await peer.untilPolling();
  const heard = inbox(adapter);
  const conversation = String(TELEGRAM_CHAT) as ConversationId;
  return {
    platform: "telegram",
    peer,
    conversation,
    send: (message) => adapter.send(conversation, message),
    receive: (text) => heard(() => peer.emitMessage(text)),
    async stop() {
      await adapter.stop();
      await peer.close();
    },
  };
}

async function wechat(): Promise<ChannelHarness> {
  const peer = await WechatPeer.start();
  // Rome's iLink adapter calls the global fetch.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = peer.fetch;
  const statePath = await mkdtemp(join(tmpdir(), "rome-wechat-peer-"));
  const adapter = peer.createAdapter(statePath);
  const heard = inbox(adapter);
  await adapter.start();
  const conversation = WECHAT_USER as ConversationId;
  return {
    platform: "wechat",
    peer,
    conversation,
    send: (message) => adapter.send(conversation, message),
    receive: (text) => heard(() => peer.emitMessage(text)),
    async stop() {
      await adapter.stop();
      await peer.close();
      globalThis.fetch = originalFetch;
      await rm(statePath, { recursive: true, force: true });
    },
  };
}

async function discord(): Promise<ChannelHarness> {
  const peer = await DiscordPeer.start();
  const adapter = peer.createAdapter();
  await adapter.start();
  await peer.server.waitFor((e) => e.request.path.endsWith("/commands") && !!e.response);
  // discord.js 14.26 drops a DM whose channel it has not cached, and READY
  // caches none. Fetch the DM so the user's first message reaches the adapter.
  // Whether Discord's real DM events avoid this is unverified.
  await (adapter as unknown as { client: Client }).client.channels.fetch(DISCORD_DM);
  const heard = inbox(adapter);
  const conversation = DISCORD_DM as ConversationId;
  return {
    platform: "discord",
    peer,
    conversation,
    send: (message) => adapter.send(conversation, message),
    receive: (text) => heard(() => peer.emitMessage(text)),
    async stop() {
      await adapter.stop();
      await peer.close();
    },
  };
}

/** Starts each platform's harness, by platform name. */
export const HARNESSES = { telegram, wechat, discord } satisfies Record<
  string,
  () => Promise<ChannelHarness>
>;

export type Platform = keyof typeof HARNESSES;
