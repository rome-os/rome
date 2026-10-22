/**
 * What a Dream or skill-review run wrote, read off its agent's file-tool calls.
 *
 * Both agents produce their output by writing files: the dream agent edits
 * memory files and writes a journal entry, the skill-review agent writes or
 * edits a `SKILL.md`. Recording those calls is what lets the UI show what came
 * out of a run without diffing the filesystem afterwards.
 *
 * Two providers report those calls in two shapes. Claude Code sends one file
 * per call, as the whole file or as the replaced and replacement text. Codex
 * sends one `fileChange` item per call, covering one or more files, each as a
 * unified diff. Both land here as the same `FileChange` rows.
 */

export type ChangeOp = "write" | "edit";

export interface FileChange {
  op: ChangeOp;
  path: string;
  /** The full file for a write, the replacement text for an edit. */
  content: string;
  /** The text an edit replaced. Null for a write. */
  previous: string | null;
  truncated: boolean;
}

/** Caps one stored change, so a full-file rewrite of a large memory file
 *  cannot bloat the run table. */
export const MAX_CHANGE_CHARS = 20_000;

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CHANGE_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_CHANGE_CHARS), truncated: true };
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

interface Hunk {
  before: string;
  after: string;
}

/**
 * Splits a unified diff into its hunks, each as the text before and after.
 * The diff carries no `---`/`+++` file header, only `@@` lines. A diff with
 * no `@@` line is one hunk.
 */
function hunksOf(diff: string): Hunk[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: Array<{ before: string[]; after: string[] }> = [];
  let current: { before: string[]; after: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      current = { before: [], after: [] };
      hunks.push(current);
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (!current) {
      current = { before: [], after: [] };
      hunks.push(current);
    }
    const text = line.slice(1);
    if (line.startsWith("-")) current.before.push(text);
    else if (line.startsWith("+")) current.after.push(text);
    else {
      // A context line is prefixed with one space. An unprefixed line is a
      // context line some diff writers emit for an empty source line.
      const context = line.startsWith(" ") ? text : line;
      current.before.push(context);
      current.after.push(context);
    }
  }
  return hunks.map((h) => ({ before: h.before.join("\n"), after: h.after.join("\n") }));
}

/**
 * The file changes in a Codex `fileChange` item. An `add` is the whole new
 * file, so it records as a write. An `update` records one edit per hunk, so
 * the page shows the same diff Codex applied. A `delete` leaves nothing to
 * show and records nothing.
 */
function changesFromFileChange(record: Record<string, unknown>): FileChange[] {
  if (!Array.isArray(record.changes)) return [];
  return record.changes.flatMap((item): FileChange[] => {
    if (!item || typeof item !== "object") return [];
    const { path, kind, diff } = item as Record<string, unknown>;
    const file = str(path);
    const text = str(diff);
    if (!file || text === null) return [];
    const type =
      kind && typeof kind === "object" ? str((kind as Record<string, unknown>).type) : null;
    switch (type) {
      case "add": {
        const content = clip(text);
        return [
          {
            op: "write",
            path: file,
            content: content.text,
            previous: null,
            truncated: content.truncated,
          },
        ];
      }
      case "update":
        return hunksOf(text).map(({ before, after }) => {
          const content = clip(after);
          const previous = clip(before);
          return {
            op: "edit",
            path: file,
            content: content.text,
            previous: previous.text,
            truncated: content.truncated || previous.truncated,
          };
        });
      default:
        return [];
    }
  });
}

/**
 * The file changes one tool call makes. Covers Claude's `Write`, `Edit`, and
 * `MultiEdit`, and the Codex `fileChange` item the provider reports as `Edit`;
 * any other tool returns nothing.
 */
export function changesFromToolUse(tool: string, input: unknown): FileChange[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  if (record.type === "fileChange") return changesFromFileChange(record);
  const path = str(record.file_path);
  if (!path) return [];

  const edit = (oldText: unknown, newText: unknown): FileChange | null => {
    const next = str(newText);
    if (next === null) return null;
    const content = clip(next);
    const previous = clip(str(oldText) ?? "");
    return {
      op: "edit",
      path,
      content: content.text,
      previous: previous.text,
      truncated: content.truncated || previous.truncated,
    };
  };

  switch (tool) {
    case "Write": {
      const text = str(record.content);
      if (text === null) return [];
      const content = clip(text);
      return [
        { op: "write", path, content: content.text, previous: null, truncated: content.truncated },
      ];
    }
    case "Edit": {
      const change = edit(record.old_string, record.new_string);
      return change ? [change] : [];
    }
    case "MultiEdit": {
      if (!Array.isArray(record.edits)) return [];
      return record.edits.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const { old_string, new_string } = item as Record<string, unknown>;
        const change = edit(old_string, new_string);
        return change ? [change] : [];
      });
    }
    default:
      return [];
  }
}

type FileArea = "journal" | "memory" | "skill" | "other";

export interface ClassifiedPath {
  area: FileArea;
  /** Short path for display. */
  label: string;
  /** Path relative to the memory directory, the form the Memory page routes on. */
  memoryFile: string | null;
  skillName: string | null;
  /** App the skill belongs to, when the path names one. */
  skillAppId: string | null;
}

const MEMORY_RE = /^(?:.*?\/)?memory\/(.+)$/;
const JOURNAL_RE = /^journal\/\d{4}\/\d{2}\/\d{2}\.md$/;
const SKILL_RE = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i;
/** Where a skill's app lives: the repo seed, an installed artifact, or a
 *  custom app's source under the profile's projects. First match wins. */
const APP_RES = [
  /(?:^|\/)rome_apps\/([^/]+)\//,
  /(?:^|\/)apps\/installed\/([^/]+)\//,
  /(?:^|\/)projects\/apps\/([^/]+)\//,
];

export function classifyPath(path: string): ClassifiedPath {
  const skill = SKILL_RE.exec(path);
  if (skill) {
    const app = APP_RES.map((re) => re.exec(path)).find(Boolean);
    return {
      area: "skill",
      label: shortPath(path),
      memoryFile: null,
      skillName: skill[1] ?? null,
      skillAppId: app?.[1] ?? null,
    };
  }

  const memory = MEMORY_RE.exec(path);
  if (memory?.[1]) {
    const memoryFile = memory[1];
    return {
      area: JOURNAL_RE.test(memoryFile) ? "journal" : "memory",
      label: memoryFile,
      memoryFile,
      skillName: null,
      skillAppId: null,
    };
  }

  return {
    area: "other",
    label: shortPath(path),
    memoryFile: null,
    skillName: null,
    skillAppId: null,
  };
}

/** Drops the machine-specific prefix: everything up to `rome_apps/`, or all
 *  but the last three segments. */
function shortPath(path: string): string {
  const appsAt = path.indexOf("rome_apps/");
  if (appsAt >= 0) return path.slice(appsAt + "rome_apps/".length);
  const segments = path.split("/").filter(Boolean);
  return segments.length > 3 ? segments.slice(-3).join("/") : segments.join("/");
}

export interface ChangedFile extends ClassifiedPath {
  path: string;
  changes: Array<Omit<FileChange, "path">>;
}

/** Groups changes by file, in the order each file was first touched. */
export function groupByFile(changes: FileChange[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const { path, ...change } of changes) {
    let file = files.get(path);
    if (!file) {
      file = { path, ...classifyPath(path), changes: [] };
      files.set(path, file);
    }
    file.changes.push(change);
  }
  return [...files.values()];
}
