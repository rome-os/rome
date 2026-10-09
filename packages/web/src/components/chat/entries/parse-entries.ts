import type { ChatMessage, TranscriptPart } from "@/lib/chat-types";

// Parse a message's `content` JSON string into its part array. A non-array /
// non-JSON payload degrades to a single text block so callers never throw.
export function parseEntries(content: string): TranscriptPart[] {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed.flatMap(wellFormed) : [{ type: "text", content }];
  } catch {
    return [{ type: "text", content }];
  }
}

// Core stores the parts a client posts with a user turn without validating
// them, so this drops or repairs the user-side parts a client could get wrong
// rather than letting one bad row break the whole transcript.
function wellFormed(part: unknown): TranscriptPart[] {
  if (!part || typeof part !== "object") return [];
  const p = part as Record<string, unknown>;
  switch (p.type) {
    case "text":
      return typeof p.content === "string" ? [part as TranscriptPart] : [];
    case "interaction_result":
      if (typeof p.toolUseId !== "string") return [];
      // Core resolves the interaction whatever `output` holds, and counts only
      // an object with `dismissed: true` as a dismissal; keep that reading.
      return [
        {
          type: "interaction_result",
          toolUseId: p.toolUseId,
          output:
            p.output && typeof p.output === "object" ? (p.output as Record<string, unknown>) : {},
        },
      ];
    default:
      return typeof p.type === "string" ? [part as TranscriptPart] : [];
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
