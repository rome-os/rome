export type DiffLine = { type: "context" | "removed" | "added"; text: string };
export type DiffRow = DiffLine | { type: "skip"; count: number };

/**
 * A line diff of one edit: the lines both sides share at the start and end are
 * context, and only the middle is removed and added. Agents usually insert by
 * anchoring on a heading and repeating it in the replacement, so the anchor
 * reads as context rather than a removal followed by an identical addition.
 */
export function lineDiff(previous: string, next: string): DiffLine[] {
  const before = previous === "" ? [] : previous.split("\n");
  const after = next === "" ? [] : next.split("\n");

  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;

  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  const context = (text: string): DiffLine => ({ type: "context", text });
  return [
    ...before.slice(0, start).map(context),
    ...before.slice(start, endBefore).map((text): DiffLine => ({ type: "removed", text })),
    ...after.slice(start, endAfter).map((text): DiffLine => ({ type: "added", text })),
    ...before.slice(endBefore).map(context),
  ];
}

/**
 * Folds unchanged lines more than `keep` lines away from a change into one
 * `skip` row, so a long anchor does not bury the lines that changed.
 */
export function foldContext(lines: DiffLine[], keep = 3): DiffRow[] {
  const changed = lines.flatMap((line, i) => (line.type === "context" ? [] : [i]));
  if (changed.length === 0) return lines;
  const first = changed[0] ?? 0;
  const last = changed.at(-1) ?? 0;
  const rows: DiffRow[] = [];
  const from = Math.max(0, first - keep);
  const to = Math.min(lines.length, last + keep + 1);
  if (from > 0) rows.push({ type: "skip", count: from });
  rows.push(...lines.slice(from, to));
  if (to < lines.length) rows.push({ type: "skip", count: lines.length - to });
  return rows;
}

/**
 * Splits YAML frontmatter off a markdown file, returning the `description`
 * field when there is one. Enough for a SKILL.md header; not a YAML parser.
 */
export function splitFrontmatter(text: string): { description: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { description: null, body: text };
  const description = /^description:\s*(.+)$/m.exec(match[1] ?? "")?.[1]?.trim() ?? null;
  return {
    description: description?.replace(/^(["'])(.*)\1$/, "$2") ?? null,
    body: text.slice(match[0].length),
  };
}

/** Drops a leading `# Title` line, for content shown under a heading of its own. */
export function stripLeadingTitle(text: string): string {
  return text.replace(/^\s*#\s[^\n]*\n+/, "");
}
