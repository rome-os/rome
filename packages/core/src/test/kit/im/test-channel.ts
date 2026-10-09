import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChannelMessage,
  ConversationId,
  MessageReceipt,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import { DISCORD_USER, DiscordPeer } from "./discord.js";
import type { Peer } from "./peer.js";
import { TELEGRAM_CHAT, TelegramPeer } from "./telegram.js";
import { WECHAT_USER, WechatPeer } from "./wechat.js";

export type Platform = "telegram" | "wechat" | "discord";

/**
 * A production adapter running against its platform's peer, with one
 * conversation open between Rome and a user. A scenario drives any platform
 * through this, so it never names one.
 */
export interface TestChannel {
  readonly platform: Platform;
  readonly peer: Peer;
  readonly conversation: ConversationId;
  /** Rome sends into the conversation through the adapter. */
  send(message: OutgoingMessage): Promise<MessageReceipt>;
  /** The user writes `text`; resolves with the message the adapter delivers. */
  receive(text: string): Promise<ChannelMessage>;
  /** Undoes the setup, latest step first, even where a step fails. */
  stop(): Promise<void>;
}

interface Adapter {
  send(conversationId: ConversationId, message: OutgoingMessage): Promise<MessageReceipt>;
  onInbound(handler: (message: ChannelMessage) => Promise<void>): void;
  stop(): Promise<void>;
}

/**
 * Runs `setup`, which registers how to undo each step it takes. If setup fails,
 * the steps already taken are undone before the error propagates, so a failed
 * start leaks no peer and no patched global.
 */
async function assemble(
  setup: (undo: (step: () => unknown) => void) => Promise<Omit<TestChannel, "stop">>,
): Promise<TestChannel> {
  const steps: Array<() => unknown> = [];
  const stop = async () => {
    const errors: unknown[] = [];
    for (const step of steps.splice(0).reverse()) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        `Test channel teardown failed: ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")}`,
      );
  };
  try {
    return { ...(await setup((step) => steps.push(step))), stop };
  } catch (error) {
    // The setup error is the one to report.
    await stop().catch(() => {});
    throw error;
  }
}

/**
 * The messages the adapter delivers, in arrival order. `receive` takes the
 * oldest, waiting up to 3 s for one, and teardown fails on any left untaken,
 * so a duplicate or stray delivery cannot pass unnoticed.
 */
function inbox(adapter: Adapter, timeoutMs = 3_000) {
  const delivered: ChannelMessage[] = [];
  let wake: (() => void) | undefined;
  adapter.onInbound(async (message) => {
    delivered.push(message);
    wake?.();
  });
  return {
    async receive(emit: () => void): Promise<ChannelMessage> {
      emit();
      let timer: NodeJS.Timeout | undefined;
      while (!delivered.length)
        await new Promise<void>((resolve, reject) => {
          wake = resolve;
          timer = setTimeout(
            () => reject(new Error(`No inbound message within ${timeoutMs} ms`)),
            timeoutMs,
          );
        }).finally(() => clearTimeout(timer));
      return delivered.shift()!;
    },
    assertTaken() {
      if (delivered.length)
        throw new Error(`${delivered.length} inbound messages no scenario received`);
    },
  };
}

const telegram = () =>
  assemble(async (undo) => {
    const peer = await TelegramPeer.start();
    undo(() => peer.close());
    const adapter = peer.createAdapter();
    const heard = inbox(adapter);
    undo(() => heard.assertTaken());
    // Registered first, so an adapter that fails to start is still stopped.
    undo(() => adapter.stop());
    await adapter.start();
    await peer.untilPolling();
    const conversation = String(TELEGRAM_CHAT) as ConversationId;
    return {
      platform: "telegram",
      peer,
      conversation,
      send: (message) => adapter.send(conversation, message),
      receive: (text) => heard.receive(() => peer.emitMessage(text)),
    };
  });

const wechat = () =>
  assemble(async (undo) => {
    // Made first so it is removed last, after the peer closes. The adapter's
    // last long poll can still write its sync state here after that, which
    // at worst leaves this temp dir behind.
    const statePath = await mkdtemp(join(tmpdir(), "rome-wechat-peer-"));
    undo(() => rm(statePath, { recursive: true, force: true }));
    const peer = await WechatPeer.start();
    undo(() => peer.close());
    // Rome's iLink adapter calls the global fetch.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = peer.fetch;
    undo(() => {
      globalThis.fetch = originalFetch;
    });
    const adapter = peer.createAdapter(statePath);
    const heard = inbox(adapter);
    undo(() => heard.assertTaken());
    // Registered first, so an adapter that fails to start is still stopped.
    undo(() => adapter.stop());
    await adapter.start();
    const conversation = WECHAT_USER as ConversationId;
    return {
      platform: "wechat",
      peer,
      conversation,
      send: (message) => adapter.send(conversation, message),
      receive: (text) => heard.receive(() => peer.emitMessage(text)),
    };
  });

const discord = () =>
  assemble(async (undo) => {
    const peer = await DiscordPeer.start();
    undo(() => peer.close());
    const adapter = peer.createAdapter();
    const heard = inbox(adapter);
    undo(() => heard.assertTaken());
    // Registered first, so an adapter that fails to start is still stopped.
    undo(() => adapter.stop());
    await adapter.start();
    await peer.server.waitFor((e) => e.request.path.endsWith("/commands") && !!e.response);
    // discord.js 14.26 drops a DM whose channel it has not cached, and READY
    // caches none. Opening the DM caches it, so the user's first message
    // reaches the adapter. Whether Discord's real DM events avoid this is
    // unverified.
    const conversation = (await adapter.directConversationFor(DISCORD_USER)) as ConversationId;
    return {
      platform: "discord",
      peer,
      conversation,
      send: (message) => adapter.send(conversation, message),
      receive: (text) => heard.receive(() => peer.emitMessage(text)),
    };
  });

/** Starts each platform's test channel, by platform name. */
export const TEST_CHANNELS: Record<Platform, () => Promise<TestChannel>> = {
  telegram,
  wechat,
  discord,
};
