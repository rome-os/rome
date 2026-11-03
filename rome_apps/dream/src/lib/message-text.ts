/**
 * The readable text of a stored `rome_agent_messages.content`, or "" when it
 * holds none. Tool calls and tool results are dropped. Content that is not
 * JSON is returned as it is, trimmed.
 */
export function extractText(rawContent: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return rawContent.trim();
  }

  if (typeof parsed === "string") return parsed.trim();

  if (Array.isArray(parsed)) {
    return parsed
      .map((block: unknown) => {
        if (typeof block === "string") return block;
        if (typeof block === "object" && block !== null) {
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result" || b.type === "tool_use") return "";
          // Stored text parts carry the text in `content`; `text` is the
          // older block shape.
          if (b.type === "text" && typeof b.content === "string") return b.content;
          if (typeof b.text === "string") return b.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return String(parsed).trim();
}
