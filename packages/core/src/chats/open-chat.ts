// A chat starts when its first message reaches Rome through one of Rome's
// accounts, or when Rome first says something there. Vocabulary:
// docs/domains/chats.md#chat.

import type { EnsureChannelChatInput } from "@rome-os/app-runtime";
import type { ChatAdapters } from "./adapter.js";
import type { ChatRepository } from "./chat-repository.js";
import type { ChatKey, ChatRef } from "./place.js";

export interface StartChannelChatDeps {
  chats: Pick<ChatRepository, "start">;
  /** The adapters, which name the chat at a channel address. */
  adapters: Pick<ChatAdapters, "chatAt" | "accountOn">;
}

/**
 * The chat at a channel address, started when Rome holds none, with no seat
 * opened in it: its ref in Chats, its adapter's key, and Rome's end, the
 * channel's account.
 */
export function startChannelChat(
  deps: StartChannelChatDeps,
  input: Pick<
    EnsureChannelChatInput,
    "channel" | "threadId" | "parentThreadId" | "threadType" | "threadName"
  >,
): { chat: ChatRef; key: ChatKey; romeEnd: string } {
  const parent =
    input.parentThreadId && input.parentThreadId !== input.threadId
      ? input.parentThreadId
      : undefined;
  const kind = parent || input.threadType !== "private" ? "group" : "dm";
  const key = deps.adapters.chatAt(input.channel, parent ?? input.threadId, kind);
  const chat = deps.chats.start(key, kind, parent ? null : (input.threadName ?? null));
  return { chat: chat.ref, key, romeEnd: deps.adapters.accountOn(input.channel).id };
}
