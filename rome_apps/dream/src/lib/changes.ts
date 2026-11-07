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

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type ChangeOp = "write" | "edit";

/** Observed provenance. `practice` means practice touched the path, not sole authorship. */
export type ChangeAttribution = "practice" | "unattributed";

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
  /** Observed provenance for filesystem changes; older agent records may omit it. */
  attribution?: ChangeAttribution | null;
}

/** `.env` files can hold secrets, so only their path is recorded. `.env.example` is source. */
const SECRET_FILE = /(?:^|\/)\.env(?!\.example$)[^/]*$/;
export const SECRET_PLACEHOLDER = "(contents not recorded)";

export function isSecretFile(path: string): boolean {
  return SECRET_FILE.test(path.replaceAll("\\", "/"));
}

/**
 * Compares paths using the filesystem's spelling when the path exists. For
 * deleted files, normalize the nearest existing parent and retain the tail.
 */
export function normalizePath(path: string): string {
  const resolved = resolve(path);
  let current = resolved;
  const tail: string[] = [];
  while (true) {
    try {
      const canonical = realpathSync.native(current);
      return tail.length === 0 ? canonical : resolve(canonical, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolved;
      tail.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export function isWithin(path: string, root: string): boolean {
  const fromRoot = relative(normalizePath(root), normalizePath(path));
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
  );
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

interface Region {
  before: string;
  after: string;
}

/**
 * Splits a unified diff into regions, one per run of changed lines, each as
 * the text before and after with the unchanged lines around it. A hunk that
 * changes two places with unchanged lines between them yields two regions,
 * because the page's line diff treats only a shared start and end as
 * context, and would show the lines between as removed and added again. The
 * diff carries no `---`/`+++` file header, only `@@` lines, and a diff with
 * no `@@` line is one hunk.
 */
function regionsOf(diff: string): Region[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const regions: Region[] = [];
  let leading: string[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  let trailing: string[] = [];
  let open = false;

  const close = () => {
    if (open) {
      regions.push({
        before: [...leading, ...removed, ...trailing].join("\n"),
        after: [...leading, ...added, ...trailing].join("\n"),
      });
    }
    // The unchanged lines after one run lead into the next.
    leading = trailing;
    removed = [];
    added = [];
    trailing = [];
    open = false;
  };

  for (const line of lines) {
    if (line.startsWith("\\")) continue;
    if (line.startsWith("@@")) {
      close();
      leading = [];
      continue;
    }
    if (line.startsWith("-") || line.startsWith("+")) {
      if (trailing.length > 0) close();
      open = true;
      (line.startsWith("-") ? removed : added).push(line.slice(1));
      continue;
    }
    // A context line is prefixed with one space. An unprefixed line is a
    // context line some diff writers emit for an empty source line.
    const text = line.startsWith(" ") ? line.slice(1) : line;
    (open ? trailing : leading).push(text);
  }
  close();
  return regions;
}

type CodexFileChangeKind = "add" | "update" | "delete";

interface CodexFileChangeItem {
  path: string;
  kind: CodexFileChangeKind;
  movePath: string | null;
  diff: string | null;
}

/** Extracts valid paths and kinds even when an item has no diff. */
function codexFileChangeItems(record: Record<string, unknown>): CodexFileChangeItem[] {
  if (!Array.isArray(record.changes)) return [];
  return record.changes.flatMap((item): CodexFileChangeItem[] => {
    if (!item || typeof item !== "object") return [];
    const itemRecord = item as Record<string, unknown>;
    const path = str(itemRecord.path);
    const kindRecord =
      itemRecord.kind && typeof itemRecord.kind === "object"
        ? (itemRecord.kind as Record<string, unknown>)
        : null;
    const kind = kindRecord ? str(kindRecord.type) : null;
    if (!path || (kind !== "add" && kind !== "update" && kind !== "delete")) return [];
    return [
      {
        path,
        kind,
        movePath: kind === "update" ? str(kindRecord?.move_path) : null,
        diff: str(itemRecord.diff),
      },
    ];
  });
}

/**
 * An add records the whole file, an update records each changed region under
 * its final path, and a delete has no rendered change.
 */
function changesFromFileChange(items: CodexFileChangeItem[]): FileChange[] {
  return items.flatMap((item): FileChange[] => {
    const text = item.diff;
    if (text === null) return [];
    switch (item.kind) {
      case "add": {
        const content = clip(text);
        return [
          {
            op: "write",
            path: item.path,
            content: content.text,
            previous: null,
            truncated: content.truncated,
          },
        ];
      }
      case "update": {
        const target = item.movePath || item.path;
        return regionsOf(text).map(({ before, after }) => {
          const content = clip(after);
          const previous = clip(before);
          return {
            op: "edit",
            path: target,
            content: content.text,
            previous: previous.text,
            truncated: content.truncated || previous.truncated,
          };
        });
      }
      case "delete":
        return [];
    }
  });
}

/**
 * Collects the changes and paths from one tool call. A delete or rename's old
 * path is tracked for practice-touch attribution even when it has no rendered diff.
 */
export function fileChangesFromToolUse(
  tool: string,
  input: unknown,
): { paths: string[]; changes: FileChange[] } {
  if (!input || typeof input !== "object") return { paths: [], changes: [] };
  const memoryWrite = memoryFileCall(tool, input as Record<string, unknown>);
  if (memoryWrite) return fileChangesFromToolUse(memoryWrite.tool, memoryWrite.input);

  const record = input as Record<string, unknown>;
  if (record.type === "fileChange") {
    const items = codexFileChangeItems(record);
    return {
      paths: items.flatMap(({ path, kind, movePath }) =>
        kind === "update" && movePath ? [path, movePath] : [path],
      ),
      changes: changesFromFileChange(items),
    };
  }

  const path = str(record.file_path);
  if (!path || !["Write", "Edit", "MultiEdit"].includes(tool)) {
    return { paths: [], changes: [] };
  }

  if (isSecretFile(path)) {
    const op: ChangeOp = tool === "Write" ? "write" : "edit";
    return {
      paths: [path],
      changes: [
        {
          op,
          path,
          content: SECRET_PLACEHOLDER,
          previous: op === "edit" ? "" : null,
          truncated: false,
        },
      ],
    };
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

  let changes: FileChange[] = [];
  switch (tool) {
    case "Write": {
      const text = str(record.content);
      if (text !== null) {
        const content = clip(text);
        changes = [
          {
            op: "write",
            path,
            content: content.text,
            previous: null,
            truncated: content.truncated,
          },
        ];
      }
      break;
    }
    case "Edit": {
      const change = edit(record.old_string, record.new_string);
      changes = change ? [change] : [];
      break;
    }
    case "MultiEdit": {
      if (!Array.isArray(record.edits)) break;
      changes = record.edits.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const { old_string, new_string } = item as Record<string, unknown>;
        const change = edit(old_string, new_string);
        return change ? [change] : [];
      });
      break;
    }
  }

  return { paths: [path], changes };
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
const APP_SOURCE_RE = /(?:^|\/)(?:projects\/apps|apps\/installed|rome_apps)\/[^/]+\//;
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

  // An app's own `memory/` folder is app source, not the guardian's memory.
  const memory = APP_SOURCE_RE.test(path) ? null : MEMORY_RE.exec(path);
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
  /** Conservative provenance from the changes recorded for this file. */
  attribution: ChangeAttribution | null;
}

/** Groups changes by file, in the order each file was first touched. */
export function groupByFile(changes: FileChange[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const { path, ...change } of changes) {
    let file = files.get(path);
    if (!file) {
      file = { path, ...classifyPath(path), changes: [], attribution: null };
      files.set(path, file);
    }
    file.changes.push(change);
    if (change.attribution === "unattributed") file.attribution = "unattributed";
    else if (change.attribution === "practice" && file.attribution === null) {
      file.attribution = "practice";
    }
  }
  return [...files.values()];
}
