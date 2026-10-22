/**
 * What a Dream or skill-review run wrote, read off its agent's file-tool calls.
 *
 * Both agents produce their output by writing files: the dream agent edits
 * memory files and writes a journal entry, the skill-review agent writes or
 * edits a `SKILL.md`. Recording those calls is what lets the UI show what came
 * out of a run without diffing the filesystem afterwards.
 */

export type ChangeOp = "write" | "edit";

export interface FileChange {
  op: ChangeOp;
  path: string;
  /** The full file for a write, the replacement text for an edit. */
  content: string;
  /**
   * The text an edit replaced. Null for a write. An edit with null previous
   * text is the dream action's record of practice notes appended to the
   * journal (`RunsRepository.practiceNotes` reads them back), so no other
   * source may emit one.
   */
  previous: string | null;
  truncated: boolean;
}

/** `.env` files can hold secrets, so only their path is recorded. `.env.example` is source. */
const SECRET_FILE = /(?:^|\/)\.env(?!\.example$)[^/]*$/;
export const SECRET_PLACEHOLDER = "(contents not recorded)";

export function isSecretFile(path: string): boolean {
  return SECRET_FILE.test(path);
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

/**
 * The dream memory agent writes through `write_memory_file` and
 * `edit_memory_file` actions, called via `execute_action`. Read as the `Write`
 * or `Edit` they stand for.
 */
function memoryFileCall(
  tool: string,
  input: Record<string, unknown>,
): { tool: string; input: Record<string, unknown> } | null {
  if (tool !== "execute_action" || typeof input.action_name !== "string") return null;
  const args = input.json_args;
  if (!args || typeof args !== "object") return null;
  const { path, ...rest } = args as Record<string, unknown>;
  const name = input.action_name.split(":").at(-1);
  if (name === "write_memory_file") return { tool: "Write", input: { file_path: path, ...rest } };
  if (name === "edit_memory_file") return { tool: "Edit", input: { file_path: path, ...rest } };
  return null;
}

/**
 * The file changes one tool call makes. Covers Claude's `Write`, `Edit`, and
 * `MultiEdit`; any other tool returns nothing.
 */
export function changesFromToolUse(tool: string, input: unknown): FileChange[] {
  if (!input || typeof input !== "object") return [];
  const memoryWrite = memoryFileCall(tool, input as Record<string, unknown>);
  if (memoryWrite) return changesFromToolUse(memoryWrite.tool, memoryWrite.input);
  const record = input as Record<string, unknown>;
  const path = str(record.file_path);
  if (!path) return [];
  if (isSecretFile(path)) {
    const op: ChangeOp = tool === "Write" ? "write" : "edit";
    if (!["Write", "Edit", "MultiEdit"].includes(tool)) return [];
    return [
      {
        op,
        path,
        content: SECRET_PLACEHOLDER,
        previous: op === "edit" ? "" : null,
        truncated: false,
      },
    ];
  }

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
