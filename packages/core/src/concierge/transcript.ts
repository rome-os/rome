// Read-only views of a stored chat transcript, in the shapes Concierge's tools
// and task events hand the model.

interface StoredRow {
  role: string;
  content: string;
  createdAt?: Date;
}

interface StoredPart {
  type?: unknown;
  content?: unknown;
  turnPhase?: unknown;
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

/** The row's text parts, joined. `answerOnly` skips in-turn narration. */
function rowText(content: string, options: { answerOnly?: boolean } = {}): string {
  return parts(content)
    .filter(
      (part) =>
        part.type === "text" &&
        typeof part.content === "string" &&
        !(options.answerOnly && part.turnPhase === "commentary"),
    )
    .map((part) => part.content as string)
    .join("\n\n")
    .trim();
}

export interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
  at?: string;
}

/** The last `limit` user and agent messages that carry text. */
export function transcriptLines(rows: StoredRow[], limit: number): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const row of rows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const text = rowText(row.content);
    if (!text) continue;
    lines.push({
      role: row.role,
      text,
      ...(row.createdAt ? { at: row.createdAt.toISOString() } : {}),
    });
  }
  return lines.slice(-limit);
}

/** The chat's latest agent answer, or null when it has none. */
export function latestAnswer(rows: StoredRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.role !== "assistant") continue;
    const text = rowText(row.content, { answerOnly: true });
    if (text) return text;
  }
  return null;
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
