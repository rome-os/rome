// A chat starts when its first message reaches Rome through one of Rome's
// accounts. Vocabulary: docs/domains/chats.md#chat.

import type { ChatId, ChatRecord, EnsureChannelChatInput } from "@rome-os/app-runtime";
import { isCoreMainAgentId } from "../apps/artifact-id.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { ChatRepository } from "./chat-repository.js";
import { chatKey } from "./place.js";

export interface OpenChannelChatDeps {
  chats: ChatRepository;
  webchatRepo: Pick<WebChatRepository, "ensureChannelChat">;
}

/**
 * The row a message at a channel address is stored under. The chat it is said
 * in starts through the channel's account when Rome holds none there yet, or
 * that account joins it. A thread address names its chat by `parentThreadId`,
 * and its own row follows. A dashboard address is opened by the dashboard
 * alone, so it starts no chat here.
 */
export function openChannelChat(
  deps: OpenChannelChatDeps,
  input: EnsureChannelChatInput,
): Promise<ChatRecord> {
  if (input.channel !== "webchat") {
    const parent =
      input.parentThreadId && input.parentThreadId !== input.threadId
        ? input.parentThreadId
        : undefined;
    const via = deps.chats.accountOn(input.channel);
    const seed = {
      agentName: isCoreMainAgentId(input.agentName) ? null : input.agentName,
      projectName: input.projectName,
      projectPath: input.projectPath ?? null,
    };
    if (parent === undefined) {
      deps.chats.startIfMissing(
        chatKey(via.platform, input.threadId as ChatId),
        input.threadType === "private" ? "dm" : "group",
        via,
        input.threadName ?? null,
        { ...seed, threadType: input.threadType ?? null },
      );
    } else {
      deps.chats.startIfMissing(chatKey(via.platform, parent as ChatId), "group", via, null, {
        ...seed,
        threadType: "group",
      });
    }
  }
  return deps.webchatRepo.ensureChannelChat(input);
}
