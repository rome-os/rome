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

/** Whether the agent has said something in the turn, as a message the chat draws. */
export function turnHasSpoken(rows: ChatRow[], turnId: string | null): boolean {
  if (!turnId) return false;
  return rows.some(
    (row) =>
      row.kind === "agent" &&
      row.messages.some((message) => message.turnId === turnId && isRenderable(message)),
  );
}

// What the last build made, keyed by the message each piece starts from. A
// build gives back the same entry and item objects for messages it has seen,
// so the memoized rows that draw them skip a render when a message arrives.
// Weak, so a message that leaves the transcript takes its objects along.
const builtEntries = new WeakMap<ChatMessage, ConciergeEntry>();
const builtItems = new WeakMap<ChatMessage, ConciergeItem[]>();

function entryFor(message: ChatMessage, endsTurn: boolean): ConciergeEntry {
  const built = builtEntries.get(message);
  if (built && built.endsTurn === endsTurn) return built;
  const entry = { message, endsTurn };
  builtEntries.set(message, entry);
  return entry;
}

/** The item `next` describes: the one the last build made for it when nothing about it changed. */
function itemFor(anchor: ChatMessage, next: ConciergeItem): ConciergeItem {
  const built = builtItems.get(anchor) ?? [];
  const same = built.find((item) => sameItem(item, next));
  if (same) return same;
  builtItems.set(anchor, [...built.filter((item) => item.kind !== next.kind), next]);
  return next;
}

function sameItem(a: ConciergeItem, b: ConciergeItem): boolean {
  if (a.kind === "separator") return b.kind === "separator" && a.key === b.key && a.at === b.at;
  if (a.kind === "notice") return b.kind === "notice" && a.key === b.key && a.model === b.model;
  return (
    b.kind === "group" &&
    a.key === b.key &&
    a.sender === b.sender &&
    a.typing === b.typing &&
    a.entries.length === b.entries.length &&
    a.entries.every((entry, index) => entry === b.entries[index])
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
 *
 * Items and entries are reference-stable: building again from the same message
 * objects returns the objects the last build returned, and only what a new or
 * changed message touches (usually the last group) comes back new. A caller
 * must not change what it gets.
 */
export function buildConciergeItems(rows: ChatRow[], opts: { typing: boolean }): ConciergeItem[] {
  type Slot =
    | { kind: "separator"; anchor: ChatMessage; key: string; at: string }
    | { kind: "notice"; key: string; model: string }
    | { kind: "group"; sender: "guardian" | "agent"; messages: ChatMessage[] };
  const slots: Slot[] = [];
  let group: Extract<Slot, { kind: "group" }> | null = null;
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
      slots.push({
        kind: "separator",
        anchor: message,
        key: `time:${message.id}`,
        at: message.createdAt,
      });
    }
    if (!group || separate || group.sender !== sender || gap >= GROUP_GAP_MS) {
      group = { kind: "group", sender, messages: [] };
      slots.push(group);
    }
    group.messages.push(message);
    previous = message;
  };

  for (const row of rows) {
    if (row.kind === "user") {
      if (isRenderable(row.message)) add(row.message, "guardian");
    } else if (row.kind === "agent") {
      for (const message of row.messages) if (isRenderable(message)) add(message, "agent");
    } else if (row.kind === "model_switch") {
      slots.push({ kind: "notice", key: row.key, model: row.model });
      group = null;
    }
  }

  // A turn can span several rows (a guardian message lands mid-turn), so the
  // last text-bearing message is found across all of them.
  const turnEnds = new Map<string, ChatMessage>();
  for (const slot of slots) {
    if (slot.kind !== "group" || slot.sender !== "agent") continue;
    for (const message of slot.messages) {
      const { turnId, sessionId } = message;
      if (turnId && hasVisibleText(message)) turnEnds.set(`${sessionId}:${turnId}`, message);
    }
  }

  const items: ConciergeItem[] = [];
  for (const slot of slots) {
    if (slot.kind === "separator") {
      items.push(itemFor(slot.anchor, { kind: "separator", key: slot.key, at: slot.at }));
    } else if (slot.kind === "notice") {
      items.push({ kind: "notice", key: slot.key, model: slot.model });
    } else {
      const entries = slot.messages.map((message) =>
        entryFor(
          message,
          slot.sender === "agent" &&
            !!message.turnId &&
            turnEnds.get(`${message.sessionId}:${message.turnId}`) === message,
        ),
      );
      items.push(
        itemFor(slot.messages[0], {
          kind: "group",
          key: slot.messages[0].id,
          sender: slot.sender,
          entries,
          typing: false,
        }),
      );
    }
  }

  if (opts.typing) {
    const last = items.at(-1);
    if (last?.kind === "group" && last.sender === "agent") {
      items[items.length - 1] = itemFor(last.entries[0].message, { ...last, typing: true });
    } else {
      items.push({ kind: "group", key: "typing", sender: "agent", entries: [], typing: true });
    }
  }
  return items;
}
