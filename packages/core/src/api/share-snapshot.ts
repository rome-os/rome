import type { TraceSnapshot } from "@rome/api-types/trace-segments";
import { type ChatPrivacyRow, privateOwnerOf } from "../concierge/privacy.js";

// The wire shape frozen into a shared chat. Mirrors the web `ChatMessage` so the
// public renderer feeds it straight into the same chat-view → ChatComponent
// pipeline as /chat, with zero re-grouping. Trace rows carry a prebuilt `traceSummary` for the feed
// trigger; the full drawer body lives in `ChatShareSnapshot.traces`.
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
  // Trace message id → prebuilt TraceSnapshot (summary + segments). Built at
  // share time with the guardian's app/agent resolver so the public read path
  // needs no resolver and the drawer renders from memory (no lazy fetch).
  traces: Record<string, TraceSnapshot>;
}

/**
 * Whether a share of `chat` may carry the work behind its messages: traces,
 * tool calls and subagents. A chat private to one owner (a Concierge chat, a
 * task chat it started, or a child session of either) shares its messages
 * only. A missing chat shares none, since its privacy can no longer be read.
 */
export function shareCarriesTraces(chat: ChatPrivacyRow | null | undefined): boolean {
  return !!chat && privateOwnerOf(chat) === null;
}

/**
 * `snapshot` without its trace rows, their summaries or their bodies. Applied
 * when a share is served too, so a share stored before the write-time rule
 * still shows no trace.
 */
export function withoutTraces(snapshot: ChatShareSnapshot): ChatShareSnapshot {
  return {
    ...snapshot,
    messages: snapshot.messages
      .filter((message) => message.role !== "trace")
      .map(({ traceSummary: _traceSummary, ...message }) => message),
    traces: {},
  };
}
