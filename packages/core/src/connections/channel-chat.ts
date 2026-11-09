// The chat at a channel address. A chat starts when its first message
// reaches Rome through one of Rome's accounts, or when Rome first says
// something there. Vocabulary: docs/domains/chats.md#chat.

import type { EnsureChannelChatInput } from "@rome-os/app-runtime";
import type { ChatRepository } from "../chats/storage/chat-repository.js";
import type { ChatKey, ChatRef } from "../chats/storage/place.js";
import { type ChatAdapters, kindNamedBy } from "./chat-adapter.js";

export interface StartChannelChatDeps {
  chats: Pick<ChatRepository, "start">;
  /** The adapters, which name the chat at a channel address. */
  adapters: Pick<ChatAdapters, "chatAt" | "accountOn" | "openedDirectMessageAt">;
}

/**
 * The chat at a channel address, started when Rome holds none, with no speaker
 * opened in it: its ref in Chats, its adapter's key, and Rome's end, the
 * channel's account. A thread's chat is its parent's, which is a group.
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
  // Where the address says which it is, it is that, whatever type the
  // caller named: a send opens every new address as private.
  const named = parent
    ? "group"
    : kindNamedBy(deps.adapters.accountOn(input.channel).platform, input.threadId);
  const kind = named ?? (input.threadType === "private" ? "dm" : "group");
  const key = deps.adapters.chatAt(input.channel, parent ?? input.threadId, kind);
  const name = parent ? null : (input.threadName ?? null);
  const chat = deps.chats.start(key, kind, name);
  // Opened at its address, the direct message is kept there, so the other
  // end's first message finds it.
  if (kind === "dm") deps.adapters.openedDirectMessageAt(input.channel, input.threadId, key);
  return { chat: chat.ref, key, romeEnd: deps.adapters.accountOn(input.channel).id };
}
