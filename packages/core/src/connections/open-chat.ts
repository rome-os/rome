// A chat starts when its first message reaches Rome through one of Rome's
// accounts. Vocabulary: docs/domains/chats.md#chat.

import type { ChatRecord, EnsureChannelChatInput } from "@rome-os/app-runtime";
import { startChannelChat, type StartChannelChatDeps } from "./channel-chat.js";
import { addressOf, type ChatAdapters } from "./chat-adapter.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { channelChatId } from "../db/session-kind.js";
import type { Speakers } from "../sessions/speakers.js";

export interface OpenChannelChatDeps {
  webchatRepo: Pick<WebChatRepository, "ensureChannelChat">;
  /** Chats and Agents' speakers: the chat starts in Chats and the row's
   *  session stands in it as the speaker of the channel's account. */
  speakers: OpenSpeakerDeps;
}

export interface OpenSpeakerDeps extends StartChannelChatDeps {
  speakers: Pick<Speakers, "speakerOf">;
  adapters: StartChannelChatDeps["adapters"] & Pick<ChatAdapters, "threadChatAt">;
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
    return openAsSpeaker(deps.webchatRepo, deps.speakers, input);
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
  named: EnsureChannelChatInput,
): Promise<ChatRecord> {
  // An address that names no parent may be a thread Rome already knows, as
  // one a reply opened: the session stands in that thread of its
  // chat, not in a chat of its own.
  const thread =
    named.parentThreadId === undefined
      ? deps.adapters.threadChatAt(named.channel, named.threadId)
      : null;
  const input: EnsureChannelChatInput = thread
    ? { ...named, parentThreadId: addressOf(thread), threadType: "group" }
    : named;
  const { chat, romeEnd } = startChannelChat(deps, input);
  // A session keeps its place while the channel's account is still the one
  // it speaks as. A channel paired again as another account moves it to that
  // account's chat; what was said in the old one stays there. A session Rome
  // holds no row for yet starts standing in the chat.
  const standing = deps.speakers.speakerOf(channelChatId(input.channel, input.threadId));
  if (standing?.accountId === romeEnd && standing.place.chat.platform === chat.platform) {
    return webchatRepo.ensureChannelChat(input);
  }
  return webchatRepo.ensureChannelChat({
    ...input,
    speaker: { chat, accountId: romeEnd, at: new Date() },
  });
}
