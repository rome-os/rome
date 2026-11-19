import type { ChatMessage } from "./chat-types";

// The server sends every message list in its final order, and the client never
// sorts: a page is held as it came, an older page goes above the held ones, a
// live message goes at the end in the order it arrived, and a message already
// held is replaced where it stands. The order is right after a reload.

/** A live message: replaces the held message with its id where it stands, else goes last. */
export function mergeChatMessage(
  messages: ChatMessage[],
  message: ChatMessage,
  /** The id of a held message this one stands in for, such as an optimistic row it replaces. */
  replaces: string = message.id,
): ChatMessage[] {
  const at = messages.findIndex((held) => held.id === replaces);
  if (at < 0) return [...messages.filter((held) => held.id !== message.id), message];
  return messages.flatMap((held, index) =>
    index === at ? [message] : held.id === message.id ? [] : [held],
  );
}

/**
 * An older page: it goes above the held messages. A held message the page
 * carries again, such as the trace of a turn that spans both pages, leaves its
 * place for the page's.
 */
export function prependChatMessages(
  currentMessages: ChatMessage[],
  olderMessages: ChatMessage[],
): ChatMessage[] {
  const olderIds = new Set(olderMessages.map((message) => message.id));
  return [...olderMessages, ...currentMessages.filter((message) => !olderIds.has(message.id))];
}

/** The page's first message that is not a trace: the one a page is placed by. */
function anchorOf(page: ChatMessage[], held: ChatMessage[]): number {
  const heldIds = new Set(held.map((message) => message.id));
  return page.findIndex((message) => message.role !== "trace" && heldIds.has(message.id));
}

/**
 * Whether a refetched newest page starts the loaded history over. That is the
 * case when none of the page's messages is held and older messages remain: the
 * ones in between were never fetched, so keeping the loaded history would
 * leave a hole mid-transcript.
 */
export function startsNewHistory(
  currentMessages: ChatMessage[],
  page: { messages: ChatMessage[]; hasOlder: boolean },
): boolean {
  if (!page.hasOlder || currentMessages.length === 0) return false;
  return anchorOf(page.messages, currentMessages) < 0;
}

/**
 * Folds a refetched newest page into the loaded transcript. The page replaces
 * the held messages from its first held message onward, and what stands above
 * stays. A held message after the page that it does not carry, such as a live
 * one that arrived after the server read it, stays after it, except the ids in
 * `dropMessageIds`. With `restart` (see {@link startsNewHistory}) the loaded
 * history goes, and only the ids in `keepMessageIds` stay after the page.
 */
export function mergeLatestMessagePage(
  currentMessages: ChatMessage[],
  fetchedMessages: ChatMessage[],
  options: {
    restart?: boolean;
    dropMessageIds?: ReadonlySet<string>;
    keepMessageIds?: ReadonlySet<string>;
  } = {},
): ChatMessage[] {
  const fetchedIds = new Set(fetchedMessages.map((message) => message.id));
  const notFetched = (message: ChatMessage) =>
    !fetchedIds.has(message.id) && !options.dropMessageIds?.has(message.id);
  if (options.restart) {
    const kept = currentMessages.filter(
      (message) => notFetched(message) && options.keepMessageIds?.has(message.id),
    );
    return [...fetchedMessages, ...kept];
  }
  const anchor = anchorOf(fetchedMessages, currentMessages);
  const anchorId = anchor < 0 ? undefined : fetchedMessages[anchor]?.id;
  const at = anchorId === undefined ? -1 : currentMessages.findIndex((m) => m.id === anchorId);
  // The page reaches none of the held messages, and no older page remains.
  if (at < 0) return [...fetchedMessages, ...currentMessages.filter(notFetched)];
  const above = currentMessages.slice(0, at).filter((message) => !fetchedIds.has(message.id));
  const below = currentMessages.slice(at).filter(notFetched);
  return [...above, ...fetchedMessages, ...below];
}
