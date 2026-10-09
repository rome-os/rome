import type { ChatMessage, TranscriptPart } from "@/lib/chat-types";

// Parse a message's `content` JSON string into its part array. A non-array /
// non-JSON payload degrades to a single text block so callers never throw.
export function parseEntries(content: string): TranscriptPart[] {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [{ type: "text", content }];
  } catch {
    return [{ type: "text", content }];
  }
}

// Per-message parse cache. The same message content gets parsed across several
// derivation passes and every render; this parses each (id, content) version
// exactly once. Keyed by message id, re-parsed only when its content changes.
const cache = new Map<string, { content: string; blocks: TranscriptPart[] }>();

export function parseMessageEntries(msg: Pick<ChatMessage, "id" | "content">): TranscriptPart[] {
  const hit = cache.get(msg.id);
  if (hit && hit.content === msg.content) return hit.blocks;
  const blocks = parseEntries(msg.content);
  cache.set(msg.id, { content: msg.content, blocks });
  return blocks;
}
