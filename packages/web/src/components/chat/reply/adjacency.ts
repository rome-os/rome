import { useRef } from "react";
import type { ConciergeItem } from "@/components/chat/concierge-groups";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";

function replyTarget(message: Parameters<typeof parseMessageEntries>[0]): string | undefined {
  const quote = parseMessageEntries(message).find((part) => part.type === "reply_to");
  return quote?.type === "reply_to" ? quote.messageId : undefined;
}

/**
 * The replies that sit right under what they answer
 * (docs/domains/chats.md#chat-thread), by message id. A reply is adjacent when
 * the previous visible message is its target, or answers the same target. An
 * adjacent reply shows no quote. Time lines and notices are not messages, and a
 * message the focus hides is not visible.
 */
export function adjacentReplies(
  items: readonly ConciergeItem[],
  hidden?: ReadonlySet<string>,
): Set<string> {
  const adjacent = new Set<string>();
  let previous: { id: string; target?: string } | null = null;
  for (const item of items) {
    if (item.kind !== "group") continue;
    for (const { message } of item.entries) {
      if (hidden?.has(message.id)) continue;
      const target = replyTarget(message);
      if (target && previous && (previous.id === target || previous.target === target)) {
        adjacent.add(message.id);
      }
      previous = { id: message.id, target };
    }
  }
  return adjacent;
}

/** The adjacent replies of one group. */
export type GroupAdjacency = ReadonlySet<string>;

/**
 * The adjacent replies of each group of `items` that has any, by group key. A
 * group whose replies are as they were keeps the same set, so a message that
 * arrives draws the group it joins and no other.
 */
export function useGroupAdjacency(
  items: readonly ConciergeItem[],
  hidden?: ReadonlySet<string>,
): ReadonlyMap<string, GroupAdjacency> {
  const kept = useRef<ReadonlyMap<string, GroupAdjacency>>(new Map());
  const all = adjacentReplies(items, hidden);
  const next = new Map<string, GroupAdjacency>();
  for (const item of items) {
    if (item.kind !== "group") continue;
    const own = new Set(item.entries.map(({ message }) => message.id).filter((id) => all.has(id)));
    if (own.size === 0) continue;
    const before = kept.current.get(item.key);
    next.set(
      item.key,
      before && before.size === own.size && [...own].every((id) => before.has(id)) ? before : own,
    );
  }
  kept.current = next;
  return next;
}
