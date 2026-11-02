// The email adapter: email as a chat platform. Contract:
// docs/architecture/channels.md#chat-adapters.
//
// A thread is a group chat. One that arrived by mail is keyed by the
// provider's thread id. One Rome opens has no thread id until the provider
// takes its first message, so the adapter keys it itself, holds who it goes
// to until that message goes, and then keeps the thread the provider named in
// the channels layer's address store. Recipients and the subject are the
// chat's, not any message's: nothing email-shaped reaches Chats. Nothing
// builds it yet: the Chats switch registers it for the email platform.

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
  type Sent,
} from "./chat-adapter.js";
import { createLogger } from "../logger.js";
import { chatKey, type ChatKey } from "./chat-ids.js";
import type { ChatAddresses } from "./chat-addresses.js";

const log = createLogger("email-chat-adapter");

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
  open(recipients: EmailRecipients, subject: string): ChatKey;
  /** As any chat adapter's `send`. A thread is a chat of its own, so a
   *  message never lands in a thread of one. */
  send(chatKey: string, threadId: ChatId | null, out: EmailOutbound): Promise<Sent>;
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
  // A thread's first message while it goes out, by key. Another message
  // into the thread waits for it, so the thread starts once.
  const starting = new Map<string, Promise<unknown>>();
  // The thread the provider named for each thread Rome started, kept here
  // too, so a thread whose address could not be stored still reaches it.
  const started = new Map<string, string>();
  const port = () => {
    if (!channel.send) throw new Error(`Channel "${channel.name}" cannot send`);
    return channel.send;
  };

  return {
    channel: base.channel,
    get account() {
      return base.account;
    },
    heard: (chat, key) => base.heard(chat, key),
    threadAt: (address) => base.threadAt(address),
    settled: () => base.settled(),
    start: (deliver, fault) => base.start(deliver, fault),
    stop: () => base.stop(),
    stream: (chat, threadId, out) => base.stream?.(chat, threadId, out) ?? null,

    open(recipients, subject) {
      const own = account();
      const key = `rome-${uuidv7()}`;
      unsent.set(key, { recipients, subject });
      return chatKey(own.platform, key as ChatId);
    },

    async send(key, _threadId, out) {
      const own = account();
      const ref = chatKey(own.platform, key as ChatId);
      const body = {
        kind: "email" as const,
        text: out.text,
        ...(out.parts ? { parts: [...out.parts] } : {}),
        ...(out.attachments ? { attachments: [...out.attachments] } : {}),
        ...(out.turnId ? { turnId: out.turnId } : {}),
        ...(out.html ? { html: out.html } : {}),
      };
      for (let first = starting.get(key); first; first = starting.get(key)) {
        await first.catch(() => {});
      }
      const opening = unsent.get(key);
      if (opening) {
        // The thread's first message starts it, and the provider names it.
        unsent.delete(key);
        const { recipients, subject } = opening;
        const first = (async (): Promise<Sent> => {
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
          started.set(key, receipt.chatId);
          // The message went out: a failed write only means mail on the
          // thread after a restart reaches a chat of its own.
          try {
            addresses.bind(own, key, receipt.chatId);
          } catch (error) {
            log.warn("could not keep an email thread's address", {
              chat: key,
              error: String(error),
            });
          }
          return {
            key: sentLineId(ref, own.id, receipt.messageId?.trim() || undefined),
            threadId: null,
          };
        })();
        starting.set(key, first);
        try {
          return await first;
        } catch (error) {
          // Nothing started the thread, so the next message starts it.
          unsent.set(key, opening);
          throw error;
        } finally {
          starting.delete(key);
        }
      }
      const replyTo = out.replyTo && platformIdOfLine(ref, own.id, out.replyTo);
      const at = started.get(key) ?? addresses.addressOf(own, key) ?? key;
      const receipt = await port().send(at as ChatId, {
        ...body,
        ...(replyTo ? { inReplyToMessageId: replyTo } : {}),
      });
      return { key: sentLineId(ref, own.id, receipt.messageId || undefined), threadId: null };
    },
  };
}
