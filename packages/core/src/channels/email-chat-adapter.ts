// The email adapter: email as a chat platform. Contract:
// docs/architecture/channels.md#chat-adapters.
//
// A thread is a group chat. One that arrived by mail is keyed by the
// provider's thread id. One Rome opens has no thread id until the provider
// takes its first message, so the adapter keys it itself, holds who it goes
// to until that message goes, and then keeps the thread the provider named in
// the channels layer's address store. Recipients and the subject are the
// chat's, not any message's: nothing email-shaped reaches Chats.

import type { Account, Channel, ChatId } from "@rome-os/app-runtime";
import { v7 as uuidv7 } from "uuid";
import {
  channelAdapter,
  platformIdOfLine,
  sentLineId,
  type ChannelAdapterDeps,
  type ChannelChatAdapter,
  type ChatAdapters,
  type Outbound,
} from "../chats/adapter.js";
import type { ChatRef } from "../chats/place.js";
import { ChatIds, chatKey } from "./chat-ids.js";
import type { ChatAddresses } from "./chat-addresses.js";

export const EMAIL_PLATFORM = "email";

/** Who a thread Rome opens goes to. */
export interface EmailRecipients {
  readonly to: string | string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
}

/** A message in an email chat: what every message carries, and an HTML body,
 *  which the provider shows in place of the text. */
export interface EmailOutbound extends Outbound {
  readonly html?: string;
}

/** The email adapter, which also opens threads. */
export interface EmailChatAdapter extends ChannelChatAdapter {
  /**
   * A new thread to `recipients` under `subject`, as a group chat the
   * adapter keys now. Nothing is sent: the thread starts with the first
   * message sent into it.
   */
  open(recipients: EmailRecipients, subject: string): ChatRef;
  send(chatId: string, threadId: ChatId | null, out: EmailOutbound): Promise<string>;
}

export function isEmailAdapter(adapter: ChannelChatAdapter): adapter is EmailChatAdapter {
  return "open" in adapter;
}

/** The email adapter over `channel`, which opens threads; throws for a
 *  channel on another platform. */
export function emailOf(adapters: Pick<ChatAdapters, "of">, channel: Channel): EmailChatAdapter {
  const adapter = adapters.of(channel);
  if (!isEmailAdapter(adapter)) throw new Error(`Channel "${channel.name}" sends no email`);
  return adapter;
}

interface Opening {
  readonly recipients: EmailRecipients;
  readonly subject: string;
}

export function emailChatAdapter(
  channel: Channel,
  deps: ChannelAdapterDeps & { addresses: Pick<ChatAddresses, "bind" | "addressOf" | "keyAt"> },
): EmailChatAdapter {
  const { addresses } = deps;
  const base = channelAdapter(channel, deps, (account, message) => ({
    key: chatKey(
      account.platform,
      (addresses.keyAt(account, message.chatId) ?? message.chatId) as ChatId,
    ),
    kind: "group",
  }));
  const account = (): Account => base.account;
  // Threads opened and not sent yet, by key. A thread is opened and its
  // first message sent in one call, so none outlives the process.
  const unsent = new Map<string, Opening>();
  const port = () => {
    if (!channel.send) throw new Error(`Channel "${channel.name}" cannot send`);
    return channel.send;
  };

  return {
    channel: base.channel,
    get account() {
      return base.account;
    },
    heard: (id) => base.heard(id),
    threadAt: (address) => base.threadAt(address),
    start: (deliver, fault) => base.start(deliver, fault),
    stop: () => base.stop(),
    stream: (chatId, threadId, out) => base.stream?.(chatId, threadId, out) ?? null,

    open(recipients, subject) {
      const own = account();
      const key = `rome-${uuidv7()}`;
      unsent.set(key, { recipients, subject });
      return ChatIds.chat(chatKey(own.platform, key as ChatId));
    },

    async send(chatId, _threadId, out) {
      const own = account();
      const ref: ChatRef = { platform: own.platform, id: chatId };
      const key = ChatIds.key(ref).externalId;
      const body = {
        kind: "email" as const,
        text: out.text,
        ...(out.parts ? { parts: [...out.parts] } : {}),
        ...(out.attachments ? { attachments: [...out.attachments] } : {}),
        ...(out.turnId ? { turnId: out.turnId } : {}),
        ...(out.html ? { html: out.html } : {}),
      };
      const opening = unsent.get(key);
      if (opening) {
        // The thread's first message starts it, and the provider names it.
        const { recipients, subject } = opening;
        const receipt = await port().send("" as ChatId, {
          ...body,
          to: Array.isArray(recipients.to) ? [...recipients.to] : recipients.to,
          ...(recipients.cc ? { cc: [...recipients.cc] } : {}),
          ...(recipients.bcc ? { bcc: [...recipients.bcc] } : {}),
          subject,
        });
        if (typeof receipt?.chatId !== "string" || !receipt.chatId.trim()) {
          throw new Error(`Channel "${channel.name}" named no thread for what it sent`);
        }
        addresses.bind(own, key, receipt.chatId);
        unsent.delete(key);
        return sentLineId(ref, own.id, receipt.messageId?.trim() || undefined);
      }
      const replyTo = out.replyTo && platformIdOfLine(ref, own.id, out.replyTo);
      const at = addresses.addressOf(own, key) ?? key;
      const receipt = await port().send(at as ChatId, {
        ...body,
        ...(replyTo ? { inReplyToMessageId: replyTo } : {}),
      });
      return sentLineId(ref, own.id, receipt.messageId || undefined);
    },
  };
}
