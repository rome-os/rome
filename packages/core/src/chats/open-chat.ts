// A chat starts when its first message reaches Rome through one of Rome's
// accounts, or when Rome first says something there. Vocabulary:
// docs/domains/chats.md#chat.

import type { ChatRecord, EnsureChannelChatInput } from "@rome-os/app-runtime";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { ChatAdapters } from "./adapter.js";
import type { ChatRepository } from "./chat-repository.js";

export interface OpenChannelChatDeps {
  chats: Pick<ChatRepository, "start">;
  webchatRepo: Pick<WebChatRepository, "ensureChannelChat">;
  /** The adapters, which name the chat at a channel address. */
  adapters: Pick<ChatAdapters, "chatAt" | "accountOn">;
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
  const { chatId, romeEnd } = startChannelChat(deps, input);
  return deps.webchatRepo.ensureChannelChat({ ...input, chatId, accountId: romeEnd });
}

/**
 * The chat at a channel address, started when Rome holds none, with no seat
 * opened in it: its id in Chats, and Rome's end, the channel's account.
 */
export function startChannelChat(
  deps: Pick<OpenChannelChatDeps, "chats" | "adapters">,
  input: Pick<
    EnsureChannelChatInput,
    "channel" | "threadId" | "parentThreadId" | "threadType" | "threadName"
  >,
): { chatId: string; romeEnd: string } {
  const parent =
    input.parentThreadId && input.parentThreadId !== input.threadId
      ? input.parentThreadId
      : undefined;
  const kind = parent || input.threadType !== "private" ? "group" : "dm";
  const chat = deps.chats.start(
    deps.adapters.chatAt(input.channel, parent ?? input.threadId, kind),
    kind,
    parent ? null : (input.threadName ?? null),
  );
  return { chatId: chat.ref.id, romeEnd: deps.adapters.accountOn(input.channel).id };
}
