// The seat one of Rome's accounts takes in a chat at a channel address.
// Vocabulary: docs/domains/chats.md#chat and docs/domains/participation.md.

import type { ChatRecord, EnsureChannelChatInput } from "@rome-os/app-runtime";
import { startChannelChat, type StartChannelChatDeps } from "../chats/open-chat.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";

export interface OpenChannelChatDeps extends StartChannelChatDeps {
  webchatRepo: Pick<WebChatRepository, "ensureChannelChat">;
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
  const { chat, romeEnd } = startChannelChat(deps, input);
  return deps.webchatRepo.ensureChannelChat({ ...input, chat, accountId: romeEnd });
}
