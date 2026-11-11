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
