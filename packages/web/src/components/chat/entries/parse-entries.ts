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

// Core stores parts it did not build without validating them: a client's user
// turn posts its own, and an app's `channels.send` to webchat writes assistant
// parts as given. So a part must be of a known kind and carry the fields that
// kind requires, or it is dropped rather than breaking the whole transcript.
// Keyed by every TranscriptPart kind, so a new kind or a renamed field fails to
// compile here.
const REQUIRED_FIELDS = {
  text: { content: "string" },
  turn_recap: { turnId: "string", content: "string" },
  approval_card: {
    approvalId: "string",
    actionName: "string",
    preview: "object",
    status: "string",
  },
  routine_draft_card: { toolUseId: "string", draft: "object" },
  pending_interaction: { toolUseId: "string", appId: "string", render: "object" },
  handoff: { toolUseId: "string", appId: "string" },
  submission_card: { payload: "object" },
  interaction_result: { toolUseId: "string" },
  handback_approved: {},
  error: { error: "string" },
} satisfies {
  [K in TranscriptPart["type"]]: Partial<
    Record<Exclude<keyof Extract<TranscriptPart, { type: K }>, "type">, "string" | "object">
  >;
};

function wellFormed(part: unknown): TranscriptPart[] {
  if (!part || typeof part !== "object") return [];
  const p = part as Record<string, unknown>;
  if (typeof p.type !== "string" || !Object.hasOwn(REQUIRED_FIELDS, p.type)) return [];
  const required: Record<string, string> = REQUIRED_FIELDS[p.type as TranscriptPart["type"]];
  for (const [field, kind] of Object.entries(required)) {
    const value = p[field];
    if (kind === "object" ? !value || typeof value !== "object" : typeof value !== kind) return [];
  }
  if (p.type === "interaction_result" && (!p.output || typeof p.output !== "object")) {
    // Core resolves the interaction whatever `output` holds, and counts only an
    // object with `dismissed: true` as a dismissal; keep that reading.
    return [{ type: "interaction_result", toolUseId: p.toolUseId as string, output: {} }];
  }
  return [part as TranscriptPart];
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
