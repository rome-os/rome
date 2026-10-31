// A chat starts when its first message reaches Rome through one of Rome's
// accounts, or when Rome first says something there. Vocabulary:
// docs/domains/chats.md#chat.

import type { Account, ChatId, ChatRecord, EnsureChannelChatInput } from "@rome-os/app-runtime";
import type { ChatAddresses } from "../channels/chat-addresses.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { ChatRepository } from "./chat-repository.js";
import { chatKey, directMessageOn, type ChatKey } from "./place.js";
import { ChatIds } from "../channels/chat-ids.js";

export interface OpenChannelChatDeps {
  chats: Pick<ChatRepository, "start">;
  webchatRepo: Pick<WebChatRepository, "ensureChannelChat">;
  /** The channels layer's address store, which knows the direct message an
   *  account heard at an address that is not its key. */
  addresses: Pick<ChatAddresses, "keyAt">;
  /** Rome's own account on a channel, or null while its record knows none. */
  accountOf(channel: string): Account | null;
  platformOfChannel(channel: string): string;
}

/**
 * The seat a message at a channel address is said through: the session of
 * the channel's account in the chat there, opened with the chat when Rome
 * holds neither yet. A thread address names its chat by `parentThreadId`. A
 * dashboard address is opened by the dashboard alone, so it starts nothing
 * here and throws when no chat is there.
 */
export async function openChannelChat(
  deps: OpenChannelChatDeps,
  input: EnsureChannelChatInput,
): Promise<ChatRecord> {
  if (input.channel === "webchat") return deps.webchatRepo.ensureChannelChat(input);
  const account = deps.accountOf(input.channel);
  const platform = account?.platform ?? deps.platformOfChannel(input.channel);
  const romeEnd = account?.id ?? input.channel;
  const parent =
    input.parentThreadId && input.parentThreadId !== input.threadId
      ? input.parentThreadId
      : undefined;
  // A direct message the account already holds at this address is that one,
  // keyed by both ends when its first message named the sender.
  const knownKey =
    !parent && input.threadType === "private"
      ? deps.addresses.keyAt({ platform, id: romeEnd }, input.threadId)
      : null;
  const chatId =
    (knownKey === null ? null : ChatIds.chat(chatKey(platform, knownKey as ChatId)).id) ??
    deps.chats.start(
      ChatIds.chat(
        keyOf(platform, romeEnd, parent ?? input.threadId, parent ? "group" : input.threadType),
      ),
      parent || input.threadType !== "private" ? "group" : "dm",
      parent ? null : (input.threadName ?? null),
    ).ref.id;
  return deps.webchatRepo.ensureChannelChat({ ...input, chatId, accountId: romeEnd });
}

/**
 * The key of the chat at a channel address. A direct message is keyed by both
 * ends. With only its address in hand, its other end is the address, which on
 * a platform that names a direct message by its own id is the best Rome
 * knows until a message names the sender.
 */
function keyOf(
  platform: string,
  romeEnd: string,
  address: string,
  threadType: string | null | undefined,
): ChatKey {
  if (threadType !== "private") return chatKey(platform, address as ChatId);
  return directMessageOn(platform, romeEnd, address, address);
}
