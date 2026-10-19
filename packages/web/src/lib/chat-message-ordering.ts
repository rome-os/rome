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
