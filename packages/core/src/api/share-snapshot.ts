import type { TraceSnapshot } from "@rome/api-types/trace-segments";

// The wire shape frozen into a shared chat. Mirrors the web `ChatMessage` so the
// public renderer feeds it straight into the same chat-view → ChatComponent
// pipeline as /chat, with zero re-grouping. A share carries messages only:
// shares made before that rule may still hold trace rows with a
// `traceSummary`, and bodies in `ChatShareSnapshot.traces`.
export interface ChatShareMessage {
  id: string;
  sessionId: string;
  turnId: string | null;
  role: string;
  content: string;
  createdAt: string;
  traceSummary?: TraceSnapshot["summary"] | null;
}

export interface ChatShareSnapshot {
  // The source session id — the chat-view root.
  mainSessionId: string;
  // The name the chat showed for its main agent when it was shared. Absent on
  // older shares, whose page falls back to "Rome".
  agentName?: string;
  messages: ChatShareMessage[];
  // Always empty on a new share, which carries no trace. Kept for the wire
  // shape: an older share may hold trace message id → TraceSnapshot here.
  traces: Record<string, TraceSnapshot>;
}

/** The title a share falls back to when its messages give none. */
export const NEUTRAL_SHARE_TITLE = "Shared chat";

/** Longest derived share title, in characters, before an ellipsis. */
const MAX_DERIVED_TITLE = 100;

/** A message's text, as the dashboard reads stored content: its text parts, or the raw string. */
function messageText(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) return typeof parsed === "string" ? parsed : content;
    return parsed
      .map((part) =>
        part && typeof part === "object" && (part as { type?: unknown }).type === "text"
          ? String((part as { content?: unknown }).content ?? "")
          : "",
      )
      .join("\n");
  } catch {
    return content;
  }
}

/** The first non-blank line of `markdown`, as plain reading text. */
function firstPlainLine(markdown: string): string {
  for (const raw of markdown.split("\n")) {
    const line = raw
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)+/, "")
      .replace(/\*\*|__|`|~~/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line) {
      return line.length > MAX_DERIVED_TITLE
        ? `${line.slice(0, MAX_DERIVED_TITLE - 1).trimEnd()}…`
        : line;
    }
  }
  return "";
}

/**
 * A share's title from what it shows: the first line of the first picked
 * turn's own message, else of that turn's first reply, else a neutral title.
 * Never the chat's name, which for a Concierge chat says nothing of the share.
 */
export function shareTitleOf(messages: ChatShareMessage[]): string {
  const firstTurn = messages[0]?.turnId;
  const turn = messages.filter((message) => message.turnId === firstTurn);
  for (const role of ["user", "assistant"]) {
    for (const message of turn) {
      if (message.role !== role) continue;
      const line = firstPlainLine(messageText(message.content));
      if (line) return line;
    }
  }
  return NEUTRAL_SHARE_TITLE;
}
