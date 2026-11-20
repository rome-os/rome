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

/** A question card's questions, as the task's `ask_question` call gave them. */
export type OpenQuestions = Record<string, unknown>[];

/** The questions of a question card in these rows, whole, or null when there is none. */
export function openQuestion(rows: StoredRow[]): OpenQuestions | null {
  for (const row of rows) {
    if (row.role !== "assistant") continue;
    for (const part of parts(row.content)) {
      if (part.type !== "pending_interaction" || part.render?.builtin !== true) continue;
      const questions = (part.render.props as { questions?: unknown } | undefined)?.questions;
      if (!Array.isArray(questions)) continue;
      const whole = questions.filter(
        (q): q is Record<string, unknown> =>
          !!q &&
          typeof q === "object" &&
          typeof (q as { question?: unknown }).question === "string",
      );
      if (whole.length > 0) return whole;
    }
  }
  return null;
}
