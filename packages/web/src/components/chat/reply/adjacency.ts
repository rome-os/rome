import { useRef } from "react";
import type { ConciergeItem } from "@/components/chat/concierge-groups";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";

/**
 * How an adjacent reply is joined to the message it answers
 * (docs/domains/chats.md#chat-thread): a `hook` up to the message above it, or
 * a straight `line` across the `gap` in px to the reply above it that answers
 * the same message.
 */
export type Adjacent = { kind: "hook" } | { kind: "line"; gap: number };

// The gap between the bubbles of one group, and between two groups that follow
// each other. Both come from the transcript's own spacing.
const IN_GROUP_GAP = 8;
const BETWEEN_GROUPS_GAP = 16;

function replyTarget(message: Parameters<typeof parseMessageEntries>[0]): string | undefined {
  const quote = parseMessageEntries(message).find((part) => part.type === "reply_to");
  return quote?.type === "reply_to" ? quote.messageId : undefined;
}

/**
 * The replies that sit right under what they answer. A reply is adjacent when
 * the previous visible message is its target, or answers the same target. In
 * the second case, with the same sender and nothing but the gap between, the
 * two are joined by a line. Time lines and notices are not messages, and a
 * message the focus hides is not visible.
 */
export function adjacentReplies(
  items: readonly ConciergeItem[],
  hidden?: ReadonlySet<string>,
): Map<string, Adjacent> {
  const adjacent = new Map<string, Adjacent>();
  const shows = (item: ConciergeItem) =>
    item.kind === "group" && item.entries.some(({ message }) => !hidden?.has(message.id));
  let previous: { id: string; target?: string; sender: string; item: number } | null = null;
  items.forEach((item, index) => {
    if (item.kind !== "group") return;
    for (const { message } of item.entries) {
      if (hidden?.has(message.id)) continue;
      const target = replyTarget(message);
      if (target && previous && (previous.id === target || previous.target === target)) {
        const sibling = previous.id !== target;
        adjacent.set(
          message.id,
          sibling ? lineOrHook(previous, item.sender, index, items, shows) : { kind: "hook" },
        );
      }
      previous = { id: message.id, target, sender: item.sender, item: index };
    }
  });
  return adjacent;
}

// A sibling reply of the same sender, with only the gap between, is joined by a
// line. Across senders the bubbles sit on opposite sides, so it is a hook.
function lineOrHook(
  previous: { sender: string; item: number },
  sender: string,
  index: number,
  items: readonly ConciergeItem[],
  shows: (item: ConciergeItem) => boolean,
): Adjacent {
  if (previous.sender !== sender) return { kind: "hook" };
  if (previous.item === index) return { kind: "line", gap: IN_GROUP_GAP };
  const between = items.slice(previous.item + 1, index);
  if (between.every((item) => item.kind === "group" && !shows(item))) {
    return { kind: "line", gap: BETWEEN_GROUPS_GAP };
  }
  return { kind: "hook" };
}

/** The adjacent replies of one group, by message id. */
export type GroupAdjacency = Readonly<Record<string, Adjacent>>;

const sameAdjacent = (a: Adjacent, b: Adjacent) =>
  a.kind === b.kind && (a.kind === "hook" || (b.kind === "line" && a.gap === b.gap));

/**
 * The adjacent replies of each group of `items`, by group key. A group whose
 * replies are as they were keeps the same object, so a message that arrives
 * draws the group it joins and no other.
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
    const own = Object.fromEntries(
      item.entries.flatMap(({ message }) => {
        const how = all.get(message.id);
        return how ? [[message.id, how] as const] : [];
      }),
    );
    if (Object.keys(own).length === 0) continue;
    const before = kept.current.get(item.key);
    const same =
      before &&
      Object.keys(before).length === Object.keys(own).length &&
      Object.entries(own).every(([id, how]) => before[id] && sameAdjacent(before[id], how));
    next.set(item.key, same ? before : own);
  }
  kept.current = next;
  return next;
}
