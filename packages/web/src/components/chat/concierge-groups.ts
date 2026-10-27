import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import { userMessageText } from "@/components/chat/chat-view";
import type { ChatRow } from "@/components/chat/chat-view";
import type { ChatMessage } from "@/lib/chat-types";

/** Messages from the same sender closer than this share one group. */
const GROUP_GAP_MS = 5 * 60_000;
/** A gap of at least this long, or a change of local day, gets a time separator. */
const SEPARATOR_GAP_MS = 15 * 60_000;

/** One message in a group. */
export interface ConciergeEntry {
  message: ChatMessage;
  /**
   * True for the last message of its turn that shows text, and only for agent
   * messages. The turn's feedback buttons belong to it, so one turn is rated
   * from one place however many bubbles it has.
   */
  endsTurn: boolean;
}

export type ConciergeItem =
  /** Centered time line before `at`, an ISO timestamp. */
  | { kind: "separator"; key: string; at: string }
  | { kind: "notice"; key: string; model: string }
  /**
   * Consecutive messages from one sender. Agent messages of separate turns share a
   * group when they are close enough in time. `typing` adds the typing bubble to
   * the end of an agent group.
   */
  | {
      kind: "group";
      key: string;
      sender: "guardian" | "agent";
      entries: ConciergeEntry[];
      typing: boolean;
    };

function isRenderable(message: ChatMessage): boolean {
  if (message.role === "user") return userMessageText(message.content).length > 0;
  return parseMessageEntries(message).some((part) => part.type !== "text" || part.content.trim());
}

function hasVisibleText(message: ChatMessage): boolean {
  return parseMessageEntries(message).some((part) => part.type === "text" && part.content.trim());
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Turns the transcript's rows into what the Concierge draws: groups of
 * same-sender messages, time separators, and model-switch notices. Two
 * adjacent messages join a group when the sender is the same and the gap
 * between their `createdAt` is under {@link GROUP_GAP_MS}. A separator comes
 * before the first message, after a gap of at least {@link SEPARATOR_GAP_MS},
 * and when the local day changes. It always ends the group before it. A message
 * with an unparsable time gets no separator and is grouped by sender alone.
 * Rows with nothing to draw (trace rows, empty messages) leave no trace.
 */
export function buildConciergeItems(rows: ChatRow[], opts: { typing: boolean }): ConciergeItem[] {
  const items: ConciergeItem[] = [];
  let group: Extract<ConciergeItem, { kind: "group" }> | null = null;
  let previous: ChatMessage | null = null;

  const add = (message: ChatMessage, sender: "guardian" | "agent") => {
    const at = Date.parse(message.createdAt);
    const before = previous ? Date.parse(previous.createdAt) : Number.NaN;
    const known = !Number.isNaN(at) && !Number.isNaN(before);
    const gap = known ? at - before : 0;
    const separate =
      !previous ||
      (known && (gap >= SEPARATOR_GAP_MS || !sameLocalDay(new Date(at), new Date(before))));
    if (separate && !Number.isNaN(at)) {
      items.push({ kind: "separator", key: `time:${message.id}`, at: message.createdAt });
    }
    if (!group || separate || group.sender !== sender || gap >= GROUP_GAP_MS) {
      group = { kind: "group", key: message.id, sender, entries: [], typing: false };
      items.push(group);
    }
    group.entries.push({ message, endsTurn: false });
    previous = message;
  };

  for (const row of rows) {
    if (row.kind === "user") {
      if (isRenderable(row.message)) add(row.message, "guardian");
    } else if (row.kind === "agent") {
      for (const message of row.messages) if (isRenderable(message)) add(message, "agent");
    } else if (row.kind === "model_switch") {
      items.push({ kind: "notice", key: row.key, model: row.model });
      group = null;
    }
  }

  // A turn can span several rows (a guardian message lands mid-turn), so the
  // last text-bearing message is found across all of them.
  const turnEnds = new Map<string, ConciergeEntry>();
  for (const item of items) {
    if (item.kind !== "group" || item.sender !== "agent") continue;
    for (const entry of item.entries) {
      const { turnId, sessionId } = entry.message;
      if (turnId && hasVisibleText(entry.message)) turnEnds.set(`${sessionId}:${turnId}`, entry);
    }
  }
  for (const entry of turnEnds.values()) entry.endsTurn = true;

  if (opts.typing) {
    const last = items.at(-1);
    if (last?.kind === "group" && last.sender === "agent") last.typing = true;
    else items.push({ kind: "group", key: "typing", sender: "agent", entries: [], typing: true });
  }
  return items;
}
