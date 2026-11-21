import { useRef } from "react";
import type { ConciergeItem } from "@/components/chat/concierge-groups";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";

/** How one message draws what it replies to (docs/domains/chats.md#chat-thread). */
export interface ReplyDrawing {
  /** Shows the quote of what the message answers at the top of its bubble. */
  quote: boolean;
  /**
   * Where the message sits in a run of the Concierge's messages that reply to
   * the same message: the first, one in the middle, or the last. Absent for a
   * message that is in none.
   */
  join?: "first" | "mid" | "last";
}

/** The id of the message `message` replies to, by the quote it carries. */
export function replyTarget(
  message: Parameters<typeof parseMessageEntries>[0],
): string | undefined {
  const quote = parseMessageEntries(message).find((part) => part.type === "reply_to");
  return quote?.type === "reply_to" ? quote.messageId : undefined;
}

/**
 * How each message draws its reply, by message id: only the messages that
 * reply to one, or sit in a run of the same reply, have an entry.
 *
 * - The Concierge's message that replies to nothing, or to the owner's message
 *   right above it, is plain.
 * - One that replies to the same message as the Concierge's message right
 *   above it joins that message in a run. A run stays inside one group
 *   (concierge-groups.ts), so a time line, a notice or the owner's message
 *   ends it.
 * - Any other reply shows a quote.
 * - The owner's message that replies to one always shows a quote.
 *
 * Time lines and notices are not messages: they never stand between a message
 * and the one right above it.
 */
export function replyDrawings(items: readonly ConciergeItem[]): Map<string, ReplyDrawing> {
  const drawings = new Map<string, ReplyDrawing>();
  let previous: { id: string; sender: "guardian" | "agent" } | null = null;
  for (const item of items) {
    if (item.kind !== "group") continue;
    // The message right above, when it is in this group.
    let above: { id: string; target?: string } | null = null;
    for (const { message } of item.entries) {
      const target = replyTarget(message);
      if (item.sender === "guardian") {
        if (target) drawings.set(message.id, { quote: true });
      } else if (target !== undefined) {
        const joins = above?.target === target;
        const plain = joins || (previous?.sender === "guardian" && previous.id === target);
        drawings.set(message.id, { quote: !plain, ...(joins ? { join: "last" as const } : {}) });
        if (joins && above) {
          const first = drawings.get(above.id);
          drawings.set(above.id, {
            quote: first?.quote ?? false,
            join: first?.join === undefined ? "first" : "mid",
          });
        }
      }
      previous = { id: message.id, sender: item.sender };
      above = { id: message.id, target };
    }
  }
  return drawings;
}

/**
 * The drawings of each group of `items` that has any, by group key. A group
 * whose drawings are as they were keeps the same map, so a message that
 * arrives draws the group it joins and no other.
 */
export function useGroupDrawings(
  items: readonly ConciergeItem[],
): ReadonlyMap<string, ReadonlyMap<string, ReplyDrawing>> {
  const kept = useRef<ReadonlyMap<string, ReadonlyMap<string, ReplyDrawing>>>(new Map());
  const all = replyDrawings(items);
  const next = new Map<string, ReadonlyMap<string, ReplyDrawing>>();
  for (const item of items) {
    if (item.kind !== "group") continue;
    const own = new Map<string, ReplyDrawing>();
    for (const { message } of item.entries) {
      const drawing = all.get(message.id);
      if (drawing) own.set(message.id, drawing);
    }
    if (own.size === 0) continue;
    const before = kept.current.get(item.key);
    next.set(item.key, before && sameDrawings(before, own) ? before : own);
  }
  kept.current = next;
  return next;
}

function sameDrawings(a: ReadonlyMap<string, ReplyDrawing>, b: ReadonlyMap<string, ReplyDrawing>) {
  if (a.size !== b.size) return false;
  for (const [id, drawing] of b) {
    const other = a.get(id);
    if (!other || other.quote !== drawing.quote || other.join !== drawing.join) return false;
  }
  return true;
}
