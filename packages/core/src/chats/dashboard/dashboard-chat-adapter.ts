// PROTOTYPE (investigation branch, not for merge): the dashboard as one more
// platform with its own chat adapter, the way email has one. Vocabulary:
// docs/domains/chats.md. Contract: connections/chat-adapter.ts.
//
// Rome is the dashboard's platform, so the adapter is the dashboard's server:
// it names each chat by the session that stands in it, and each message the
// browser sends by the browser's own id for it. Chats keeps Rome's id and that
// key, as for every platform, and reads no meaning into the key.

import type { Account, ChatId } from "@rome-os/app-runtime";
import {
  channelAdapter,
  type ChannelChatAdapter,
  type Inbound,
  type PlatformAdapter,
} from "../../connections/chat-adapter.js";
import { chatKey } from "../../connections/chat-ids.js";

/** What the browser posts: the message, in the chat of session `chat`. */
export interface BrowserSend {
  readonly chat: string;
  /** The browser's own id for the message, which a retry repeats. */
  readonly key: string;
  readonly sender: Account;
  readonly text: string;
  readonly at: Date;
}

/** The dashboard adapter, which also takes what the browser posts. */
export interface DashboardChatAdapter extends ChannelChatAdapter {
  /**
   * Hand `sent` to Chats and answer the id Chats recorded it under, or null
   * when it was on record already. The browser waits on this, so unlike a
   * platform's inbound port it is not queued behind the chat's other
   * messages here: the route answers once Chats has it.
   */
  receive(sent: BrowserSend): Promise<number | null>;
}

/**
 * The dashboard's adapter over its channel, one per agent's dashboard account.
 * A chat is keyed by the id of the session that stands in it, so the guardian
 * holds many direct messages with one agent, one per chat they start, as an
 * email account holds one chat per thread.
 */
export const dashboardChatAdapter: PlatformAdapter = (channel, deps) => {
  const base = channelAdapter(channel, deps, (account, message) => ({
    key: chatKey(account.platform, message.chatId),
    kind: "dm",
  }));
  let deliver: ((message: Inbound) => Promise<number | null>) | null = null;
  const adapter: DashboardChatAdapter = Object.assign(Object.create(base) as ChannelChatAdapter, {
    start(
      handOver: (message: Inbound) => Promise<number | null>,
      fault: (error: Error) => void,
    ) {
      deliver = handOver;
      base.start(handOver, fault);
    },
    async stop() {
      deliver = null;
      await base.stop();
    },
    async receive(sent: BrowserSend): Promise<number | null> {
      if (!deliver) throw new Error("The dashboard adapter is not receiving");
      const account = base.account;
      return await deliver({
        chat: chatKey(account.platform, sent.chat as ChatId),
        chatKind: "dm",
        chatName: null,
        thread: null,
        key: sent.key,
        sender: { accountId: sent.sender.id },
        text: sent.text,
        attachments: [],
        saidAt: sent.at,
        via: {
          channel: channel.name,
          account,
          // No Connection backs the dashboard (docs/domains/connections.md).
          connectionId: "",
          address: sent.chat as ChatId,
        },
      });
    },
  });
  return adapter;
};
