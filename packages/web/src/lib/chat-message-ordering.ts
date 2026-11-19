import type { ChatMessage } from "./chat-types";

function messageTimestamp(msg: ChatMessage): number {
  const parsed = Date.parse(msg.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The messages in the order they were said: by time, and where two were said in
 * the same second, in the order given. Whichever turn a message belongs to, it
 * stands where it was said.
 */
export function orderChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((msg, index) => ({ msg, index }))
    .sort((a, b) => messageTimestamp(a.msg) - messageTimestamp(b.msg) || a.index - b.index)
    .map(({ msg }) => msg);
}

export function mergeChatMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const next = messages.filter((existing) => existing.id !== message.id);
  next.push(message);
  return orderChatMessages(next);
}

export function mergeFetchedChatMessages(
  currentMessages: ChatMessage[],
  fetchedMessages: ChatMessage[],
  options: { dropMessageIds?: ReadonlySet<string> } = {},
): ChatMessage[] {
  const fetchedIds = new Set(fetchedMessages.map((message) => message.id));
  const preservedCurrent = currentMessages.filter(
    (message) => !fetchedIds.has(message.id) && !options.dropMessageIds?.has(message.id),
  );
  return orderChatMessages([...fetchedMessages, ...preservedCurrent]);
}

/**
 * Whether a refetched newest page starts the loaded history over. That is the
 * case when the page reaches back to none of the loaded messages and older
 * messages remain: the ones in between were never fetched, so keeping the
 * loaded history would leave a hole mid-transcript.
 */
export function startsNewHistory(
  currentMessages: ChatMessage[],
  page: { messages: ChatMessage[]; hasOlder: boolean },
): boolean {
  if (!page.hasOlder || currentMessages.length === 0) return false;
  const fetchedIds = new Set(page.messages.map((message) => message.id));
  return !currentMessages.some((message) => fetchedIds.has(message.id));
}

/**
 * Folds a refetched newest page into the loaded transcript: the page replaces
 * the messages it carries and leaves older loaded pages alone. With `restart`
 * (see {@link startsNewHistory}) the loaded messages older than the page go.
 */
export function mergeLatestMessagePage(
  currentMessages: ChatMessage[],
  fetchedMessages: ChatMessage[],
  options: { restart?: boolean; dropMessageIds?: ReadonlySet<string> } = {},
): ChatMessage[] {
  if (!options.restart || fetchedMessages.length === 0) {
    return mergeFetchedChatMessages(currentMessages, fetchedMessages, options);
  }
  // A page carries the traces of its turns, which may be older than every message on it.
  const said = fetchedMessages.filter((message) => message.role !== "trace");
  const oldestFetched = Math.min(
    ...(said.length > 0 ? said : fetchedMessages).map(messageTimestamp),
  );
  const history = currentMessages
    .filter((message) => messageTimestamp(message) < oldestFetched)
    .map((message) => message.id);
  return mergeFetchedChatMessages(currentMessages, fetchedMessages, {
    dropMessageIds: new Set([...history, ...(options.dropMessageIds ?? [])]),
  });
}
