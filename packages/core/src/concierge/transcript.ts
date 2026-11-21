// Read-only views of a stored chat transcript, in the shapes Concierge's task
// events hand the model. Cards are not on a message's body until widgets land,
// so a task chat's open question is read off its rows.

interface StoredRow {
  id?: string;
  role: string;
  content: string;
}

interface StoredPart {
  type?: unknown;
  render?: { builtin?: unknown; componentId?: unknown; props?: unknown };
}

function parts(content: string): StoredPart[] {
  try {
    const parsed: unknown = JSON.parse(content);
    return Array.isArray(parsed) ? (parsed as StoredPart[]) : [];
  } catch {
    return [];
  }
}

export interface OpenQuestion {
  /** The message that holds the card: the id `card_forward` takes. */
  messageId: string;
  /** Its questions in one line, each with its options. */
  line: string;
}

/** A question card in these rows, as one line with the message that holds it, or null when there is none. */
export function openQuestion(rows: StoredRow[]): OpenQuestion | null {
  for (const row of rows) {
    if (row.role !== "assistant" || !row.id) continue;
    for (const part of parts(row.content)) {
      if (part.type !== "pending_interaction" || part.render?.builtin !== true) continue;
      if (part.render.componentId !== "question-card") continue;
      const questions = (part.render.props as { questions?: unknown } | undefined)?.questions;
      const asked = (Array.isArray(questions) ? questions : []).flatMap((q) => {
        const { question, options } = (q ?? {}) as { question?: unknown; options?: unknown };
        if (typeof question !== "string") return [];
        const choices = Array.isArray(options)
          ? options.filter((option): option is string => typeof option === "string")
          : [];
        return [choices.length ? `${question} (options: ${choices.join(" | ")})` : question];
      });
      if (asked.length) return { messageId: row.id, line: asked.join(" · ") };
    }
  }
  return null;
}
