import type { Account, ChannelMessage, ThreadContext } from "@rome-os/app-runtime";
import type { PromptFacts, UnseenMessage } from "../agent/index.js";
import type { SenderLabels } from "../chats/sender-labels.js";
import type { MessageRepository } from "../chats/storage/message-repository.js";
import { contextOf, type ContextLine, type TurnLinks } from "../sessions/turn-links.js";
import { type ChannelSurfaces, surfaceOf } from "./session-opening.js";

/** How many of a chat's latest messages a new session reads from the
 *  platform: one page of Slack's, which answers one read a minute for a
 *  workspace. */
export const EARLIER_MESSAGES = 15;
/** How much of one earlier message's text a new session reads. */
const EARLIER_MESSAGE_CHARS = 500;
/** How much text of earlier messages a new session reads in all. */
const EARLIER_TOTAL_CHARS = 4_000;
/** How long a new session's first turn waits for the earlier messages. A
 *  platform that makes reads wait their turn, such as Slack, answers the next
 *  session that opens on a busy workspace too late, and it opens without. */
const EARLIER_WAIT_MS = 5_000;

export interface ChatPromptFactsDeps {
  /** What was said in each chat that a session has not seen. */
  facts: Pick<TurnLinks, "unseen" | "seen">;
  /** The messages Chats holds, by id. */
  messages: Pick<MessageRepository, "byIds">;
  /** Who said each message, as the agent reads it. */
  labels: Pick<SenderLabels, "read" | "readUnseen">;
  /** The channel that opened a chat, or null for a chat no channel opened. */
  channelOfChat: (chatId: string) => string | null;
  channelSurface: ChannelSurfaces;
  /**
   * The latest messages of the chat `place` names said at or before `until`,
   * newest first, as the channel reads them from where the chat lives. The
   * bound applies before the limit, so messages said since the session's
   * first take no room. Rejects where it reads none. Absent, a new session
   * reads nothing earlier.
   */
  latest?: (
    place: ThreadContext,
    read: { limit: number; until: Date },
  ) => Promise<ChannelMessage[]>;
  /** How long a read of the latest messages may take. Defaults to 5s. */
  latestWaitMs?: number;
}

/**
 * The prompt facts, answering that a session catches up on nothing in a chat
 * whose channel already hands the agent every message, as web chat does, and
 * that a new session in a direct message reads that chat's latest messages
 * from the platform.
 */
export function chatPromptFacts(deps: ChatPromptFactsDeps): PromptFacts {
  const handsEveryMessage = (channel: string) =>
    !surfaceOf(deps.channelSurface, channel).promptContext;
  return {
    async unseen(chatId) {
      const channel = deps.channelOfChat(chatId);
      if (channel && handsEveryMessage(channel)) return null;
      return deps.labels.readUnseen(deps.facts.unseen(chatId));
    },
    read: async (messageIds) => deps.labels.read(deps.messages.byIds(messageIds).map(contextOf)),
    seen: (messageIds, chatId, turnId) => deps.facts.seen(messageIds, chatId, turnId),
    async earlier(place, before) {
      // Only a direct message: in a group, the platform also holds what was
      // said before Rome joined, which no turn's catch-up shows.
      if (
        !deps.latest ||
        !place.threadId ||
        place.threadType !== "private" ||
        handsEveryMessage(place.channel)
      )
        return null;
      // One more than kept: the bound takes in a message said at `before`.
      const read = deps.latest(place, { limit: EARLIER_MESSAGES + 1, until: before });
      read.catch(() => {});
      const page = await within(read, deps.latestWaitMs ?? EARLIER_WAIT_MS);
      if (!page) return null;
      const said = earlierMessages(page, before);
      const labelled = await deps.labels.read(said.map((message, i) => lineOf(message, -(i + 1))));
      return labelled.map(
        (message, i): UnseenMessage => ({
          ...message,
          fromRome: said[i].direction === "outbound",
          quoted: null,
          quotesOutside: false,
        }),
      );
    },
  };
}

/** The messages of `page` said before `before`, oldest first, within the
 *  bounds a new session reads. */
function earlierMessages(page: readonly ChannelMessage[], before: Date): ChannelMessage[] {
  const said = page
    .filter((message) => message.timestamp.getTime() < before.getTime())
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, EARLIER_MESSAGES);
  const kept: ChannelMessage[] = [];
  let chars = 0;
  for (const message of said) {
    const text = clipped(message.text ?? "");
    if (chars + text.length > EARLIER_TOTAL_CHARS) break;
    chars += text.length;
    kept.push({ ...message, text });
  }
  return kept.reverse();
}

/** A platform's message as the line a turn's context shows, under `id`: a
 *  negative one, which no message Rome records has. The sender's
 *  account is the platform's id for them on the platform of Rome's account,
 *  as Chats records it, so People names them as it names a stored message. */
function lineOf(message: ChannelMessage, id: number): ContextLine {
  const fromRome = message.direction === "outbound";
  const platform = message.account?.platform;
  const account: Account | null =
    !fromRome && platform && message.senderId ? { platform, id: message.senderId } : null;
  // As a stored message reads (sessions/turn-links contextOf): an outbound
  // message keeps the name the platform gives its sender, since on a
  // personal account the guardian writes from Rome's account too.
  const named = message.senderDisplayName ?? message.senderUsername ?? null;
  return {
    id,
    senderName: named ?? (fromRome ? "Rome" : null),
    account,
    text: message.text ?? "",
    at: message.timestamp,
  };
}

function clipped(text: string): string {
  return text.length > EARLIER_MESSAGE_CHARS ? `${text.slice(0, EARLIER_MESSAGE_CHARS)}…` : text;
}

/** `work`'s answer, or null when it rejects or takes longer than `ms`. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}
