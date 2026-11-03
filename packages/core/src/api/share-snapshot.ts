import type { TraceSnapshot } from "@rome/api-types/trace-segments";

// The wire shape frozen into a shared chat. Mirrors the web `ChatMessage` so the
// public renderer feeds it straight into the same chat-view → ChatComponent
// pipeline as /chat, with zero re-grouping. Parent + handoff-child messages all
// live in one array, each tagged with its own `sessionId` (chat-view splices
// children by it). Trace rows carry a prebuilt `traceSummary` for the feed
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
  // The source (parent) session id — the chat-view root.
  mainSessionId: string;
  messages: ChatShareMessage[];
  // Trace message id → prebuilt TraceSnapshot (summary + segments). Built at
  // share time with the guardian's app/agent resolver so the public read path
  // needs no resolver and the drawer renders from memory (no lazy fetch).
  traces: Record<string, TraceSnapshot>;
}

// Minimal block shape for snapshot building — we only read handoff links here.
interface ShareEvent {
  type?: string;
  childSessionId?: string;
}

/** Child session ids referenced by `handoff` blocks in a message's content. */
export function handoffChildSessionIds(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const block of parsed as ShareEvent[]) {
    if (block && block.type === "handoff" && typeof block.childSessionId === "string") {
      out.push(block.childSessionId);
    }
  }
  return out;
}
