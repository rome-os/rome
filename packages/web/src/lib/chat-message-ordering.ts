import type { ChatMessage } from "./chat-types";

function messageTimestamp(msg: ChatMessage): number {
  const parsed = Date.parse(msg.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function orderChatMessages(messages: ChatMessage[]): ChatMessage[] {
  const groupStartedAt = new Map<string, number>();
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const groupKey = msg.turnId ?? msg.id;
    const startedAt = messageTimestamp(msg) || i;
    const current = groupStartedAt.get(groupKey);
    if (current === undefined || startedAt < current) {
      groupStartedAt.set(groupKey, startedAt);
    }
  }

  return messages
    .map((msg, index) => ({ msg, index }))
    .sort((a, b) => {
      const aGroup = groupStartedAt.get(a.msg.turnId ?? a.msg.id) ?? messageTimestamp(a.msg);
      const bGroup = groupStartedAt.get(b.msg.turnId ?? b.msg.id) ?? messageTimestamp(b.msg);
      if (aGroup !== bGroup) return aGroup - bGroup;
      const aTime = messageTimestamp(a.msg);
      const bTime = messageTimestamp(b.msg);
      if (aTime !== bTime) return aTime - bTime;
      return a.index - b.index;
    })
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
 * turns remain: the turns in between were never fetched, so keeping the loaded
 * history would leave a hole mid-transcript.
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
  const oldestFetched = Math.min(...fetchedMessages.map(messageTimestamp));
  const history = currentMessages
    .filter((message) => messageTimestamp(message) < oldestFetched)
    .map((message) => message.id);
  return mergeFetchedChatMessages(currentMessages, fetchedMessages, {
    dropMessageIds: new Set([...history, ...(options.dropMessageIds ?? [])]),
  });
}
