// Read-only views of a stored chat transcript, in the shapes Concierge's task
// events hand the model. Cards are not on a message's body until widgets land,
// so a task chat's open question is read off its rows.

interface StoredRow {
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
  question: string;
  options?: string[];
}

/** The first question of a question card in these rows, or null when there is none. */
export function openQuestion(rows: StoredRow[]): OpenQuestion | null {
  for (const row of rows) {
    if (row.role !== "assistant") continue;
    for (const part of parts(row.content)) {
      if (part.type !== "pending_interaction" || part.render?.builtin !== true) continue;
      const questions = (part.render.props as { questions?: unknown } | undefined)?.questions;
      const first = Array.isArray(questions) ? (questions[0] as Record<string, unknown>) : null;
      if (!first || typeof first.question !== "string") continue;
      const options = Array.isArray(first.options)
        ? first.options.filter((option): option is string => typeof option === "string")
        : [];
      return { question: first.question, ...(options.length ? { options } : {}) };
    }
  }
  return null;
}
