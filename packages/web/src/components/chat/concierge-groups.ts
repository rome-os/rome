import type { SystemInputSource } from "@rome/api-types/trace-segments";
import type { QuotaSwitchPart } from "@rome/api-types/chat";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import { userMessageText } from "@/components/chat/chat-view";
import type { ChatRow } from "@/components/chat/chat-view";
import type { ChatMessage } from "@/lib/chat-types";
import type { TraceSnapshot } from "@rome/api-types/trace-segments";
import type { LivePreview } from "@/components/chat/MessageList";

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
  /**
   * Where the input of the message's turn came from, when the Concierge spoke
   * on its own rather than answering its owner: a routine, an app, another
   * agent, or what it follows. Drawn as one quiet label under the message.
   */
  source?: SystemInputSource;
}

export type ConciergeItem =
  /** Centered time line before `at`, an ISO timestamp. */
  | { kind: "separator"; key: string; at: string }
  | { kind: "notice"; key: string; model: string; quota?: QuotaSwitchPart }
  /** Line above the first message that was unread when the chat opened. */
  | { kind: "unread"; key: string }
  /** Faint line where the chat's agent session was renewed, for `reason`. */
  | { kind: "renewal"; key: string; reason: string }
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

const UNREAD_DIVIDER: ConciergeItem = { kind: "unread", key: "unread-divider" };

/** Whether the Concierge draws something for `message`. */
export function isRenderable(message: ChatMessage): boolean {
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

/** Whether turn `turnId` took one of the owner's messages as its input. */
function turnTookOwnerMessage(rows: ChatRow[], turnId: string | null): boolean {
  if (!turnId) return false;
  return rows.some((row) => row.kind === "user" && row.message.turnId === turnId);
}

// The tools whose call is itself a message the chat draws: once one lands,
// nothing is left to type for it.
const MESSAGE_TOOLS = new Set(["say", "chat_forward"]);

/** A tool's name without its provider or group prefix (`mcp__rome__say`, `core:say`). */
function bareTool(tool: string): string {
  const afterMcp = tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
  return (
    afterMcp.includes(":") ? afterMcp.slice(afterMcp.lastIndexOf(":") + 1) : afterMcp
  ).toLowerCase();
}

/**
 * Whether the live trace has a call open, other than one that says a message:
 * the turn is working on something the chat does not show yet.
 */
export function hasOpenWorkCall(snapshot: TraceSnapshot | null): boolean {
  if (!snapshot) return false;
  const blocks = [...snapshot.segments]
    .sort((a, b) => a.ordinal - b.ordinal)
    .flatMap((segment) => (segment.kind === "run" ? segment.blocks : [segment.block]));
  const open = new Map<string, string>();
  let anon = 0;
  for (const block of blocks) {
    if (block.type === "tool_use") open.set(block.id ?? `anon:${anon++}`, block.tool);
    else if (block.type === "tool_result") {
      if (block.toolUseId) open.delete(block.toolUseId);
      else {
        const last = [...open.keys()].reverse().find((key) => key.startsWith("anon:"));
        if (last) open.delete(last);
      }
    }
  }
  return [...open.values()].some((tool) => !MESSAGE_TOOLS.has(bareTool(tool)));
}

/**
 * Whether the Concierge chat shows its typing dots. A turn that took the
 * owner's message shows none: that message's status reaction already says
 * the Concierge is on it (docs/domains/chats.md#status-reaction). Any other
 * turn, such as one bringing back a task's result, shows them until it says
 * its first message, unless it is quiet. Once it has said one they show only
 * while it is in a call other than one that says a message, so a turn that
 * only closes off after its last message (writing its private `done`) shows
 * none.
 */
export function showsTyping(
  rows: ChatRow[],
  live: Pick<LivePreview, "isStreaming" | "runningTurnId" | "quiet" | "snapshot">,
): boolean {
  if (!live.isStreaming) return false;
  if (turnTookOwnerMessage(rows, live.runningTurnId)) return false;
  if (!turnHasSpoken(rows, live.runningTurnId)) return !live.quiet;
  return hasOpenWorkCall(live.snapshot);
}

// What the last build made, keyed by the message each piece starts from. A
// build gives back the same entry and item objects for messages it has seen,
// so the memoized rows that draw them skip a render when a message arrives.
// Weak, so a message that leaves the transcript takes its objects along.
const builtEntries = new WeakMap<ChatMessage, ConciergeEntry>();
const builtItems = new WeakMap<ChatMessage, ConciergeItem[]>();

function entryFor(
  message: ChatMessage,
  endsTurn: boolean,
  source: SystemInputSource | undefined,
): ConciergeEntry {
  const built = builtEntries.get(message);
  if (
    built &&
    built.endsTurn === endsTurn &&
    built.source?.type === source?.type &&
    built.source?.name === source?.name
  ) {
    return built;
  }
  const entry: ConciergeEntry = { message, endsTurn, ...(source ? { source } : {}) };
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
  if (a.kind === "renewal") return b.kind === "renewal" && a.key === b.key && a.reason === b.reason;
  if (a.kind === "unread") return b.kind === "unread";
  if (a.kind === "notice")
    return (
      b.kind === "notice" &&
      a.key === b.key &&
      a.model === b.model &&
      a.quota?.from === b.quota?.from &&
      a.quota?.to === b.quota?.to
    );
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
 * same-sender messages, time separators, model-switch notices, and the unread
 * divider. Two
 * adjacent messages join a group when the sender is the same and the gap
 * between their `createdAt` is under {@link GROUP_GAP_MS}. A separator comes
 * before the first message, after a gap of at least {@link SEPARATOR_GAP_MS},
 * and when the local day changes. It always ends the group before it. A message
 * with an unparsable time gets no separator and is grouped by sender alone.
 * The unread divider comes before the message `opts.unreadFrom` names, after
 * that message's separator, and it ends the group before it. A chat that does
 * not draw that message has no divider.
 * Rows with nothing to draw (trace rows, empty messages) leave no trace.
 *
 * Items and entries are reference-stable: building again from the same message
 * objects returns the objects the last build returned, and only what a new or
 * changed message touches (usually the last group) comes back new. A caller
 * must not change what it gets.
 */
export function buildConciergeItems(
  rows: ChatRow[],
  opts: { typing: boolean; unreadFrom?: string | null },
): ConciergeItem[] {
  type Slot =
    | { kind: "separator"; anchor: ChatMessage; key: string; at: string }
    | { kind: "notice"; key: string; model: string; quota?: QuotaSwitchPart }
    | { kind: "renewal"; key: string; reason: string }
    | { kind: "unread" }
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
    if (message.id === opts.unreadFrom) {
      slots.push({ kind: "unread" });
      group = null;
    }
    if (!group || separate || group.sender !== sender || gap >= GROUP_GAP_MS) {
      group = { kind: "group", sender, messages: [] };
      slots.push(group);
    }
    group.messages.push(message);
    previous = message;
  };

  // Where each turn's input came from, when it was not the owner's own words.
  // The chat draws no line for it: the turn's replies carry it as a label.
  const sources = new Map<string, SystemInputSource>();
  let automaticModel: string | undefined;
  for (const row of rows) {
    if (row.kind === "user") {
      // A Concierge chat holds no automated messages. One from before that
      // rule, sent on the owner's behalf or not, is no owner's bubble: like a
      // newer one, it names the replies of the turn it started.
      const sender = row.message.sender;
      if (sender?.kind === "automated") {
        if (row.message.turnId) {
          sources.set(row.message.turnId, {
            type: sender.sourceType ?? "automation",
            name: sender.name,
          });
        }
      } else if (isRenderable(row.message)) add(row.message, "guardian");
    } else if (row.kind === "agent") {
      for (const message of row.messages) {
        // Only a Concierge chat's transcript is grouped here, and any of them may switch.
        const quota = parseMessageEntries(message).find(
          (part): part is QuotaSwitchPart => part.type === "quota_switch",
        );
        if (quota) {
          slots.push({ kind: "notice", key: message.id, model: quota.model, quota });
          automaticModel = quota.model;
          group = null;
        } else if (isRenderable(message)) add(message, "agent");
      }
    } else if (row.kind === "session_renewal") {
      slots.push({
        kind: "renewal",
        key: row.key,
        reason: row.reason,
      });
      group = null;
    } else if (row.kind === "automated_input") {
      sources.set(row.turnId, row.source);
    } else if (row.kind === "model_switch") {
      if (row.model === automaticModel) {
        automaticModel = undefined;
        continue;
      }
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
    if (slot.kind === "unread") {
      items.push(UNREAD_DIVIDER);
    } else if (slot.kind === "separator") {
      items.push(itemFor(slot.anchor, { kind: "separator", key: slot.key, at: slot.at }));
    } else if (slot.kind === "notice" || slot.kind === "renewal") {
      items.push(slot);
    } else {
      const entries = slot.messages.map((message) =>
        entryFor(
          message,
          slot.sender === "agent" &&
            !!message.turnId &&
            turnEnds.get(`${message.sessionId}:${message.turnId}`) === message,
          slot.sender === "agent" && message.turnId ? sources.get(message.turnId) : undefined,
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
