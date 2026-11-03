// A chat starts when its first message reaches Rome through one of Rome's
// accounts. Vocabulary: docs/domains/chats.md#chat.

import type { ChatId, ChatRecord, EnsureChannelChatInput } from "@rome-os/app-runtime";
import { isCoreMainAgentId } from "../apps/artifact-id.js";
import { startChannelChat, type StartChannelChatDeps } from "../connections/channel-chat.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { Speakers } from "../sessions/speakers.js";
import type { ChatRepository } from "./chat-repository.js";
import { chatKey } from "./place.js";

export interface OpenChannelChatDeps {
  /** Today's chats, which the chat starts in. Unused when `speakers` is
   *  given. */
  chats?: ChatRepository;
  webchatRepo: Pick<WebChatRepository, "ensureChannelChat">;
  /** Chats and Agents' speakers. Given, the chat starts in Chats and the
   *  row's session stands in it as the speaker of the channel's account. */
  speakers?: OpenSpeakerDeps;
}

export interface OpenSpeakerDeps extends StartChannelChatDeps {
  speakers: Pick<Speakers, "speakerOf">;
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
  if (input.channel !== "webchat" && deps.speakers) {
    return openAsSpeaker(deps.webchatRepo, deps.speakers, input);
  }
  if (input.channel !== "webchat" && deps.chats) {
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

/**
 * The row a message at a channel address is stored under, with its session
 * standing in the chat Rome holds there, started when it holds none. A
 * session that already stands somewhere keeps its place, and its activity is
 * left alone: only a session that stands nowhere yet is placed.
 */
async function openAsSpeaker(
  webchatRepo: OpenChannelChatDeps["webchatRepo"],
  deps: OpenSpeakerDeps,
  input: EnsureChannelChatInput,
): Promise<ChatRecord> {
  const { chat, romeEnd } = startChannelChat(deps, input);
  const opened = await webchatRepo.ensureChannelChat(input);
  // A session keeps its place while the channel's account is still the one
  // it speaks as. A channel paired again as another account moves it to that
  // account's chat; what was said in the old one stays there.
  const standing = deps.speakers.speakerOf(opened.id);
  if (standing?.accountId === romeEnd && standing.place.chat.platform === chat.platform) {
    return opened;
  }
  return webchatRepo.ensureChannelChat({
    ...input,
    speaker: { chat, accountId: romeEnd, at: new Date() },
  });
}
