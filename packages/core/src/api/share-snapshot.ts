import type { TraceSnapshot } from "@rome/api-types/trace-segments";

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
  // Set on a share of one message: the message it froze. It keeps a message
  // to one live link, which a second Share finds again.
  messageId?: string;
  messages: ChatShareMessage[];
  // Trace message id → prebuilt TraceSnapshot (summary + segments). Built at
  // share time with the guardian's app/agent resolver so the public read path
  // needs no resolver and the drawer renders from memory (no lazy fetch).
  traces: Record<string, TraceSnapshot>;
}
