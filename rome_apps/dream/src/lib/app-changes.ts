/**
 * What a dream changed in the guardian's apps, found by comparing the apps
 * directory before and after the practice agent runs.
 *
 * The agent can change an app with Bash or through the coding agent, and
 * neither shows up as a file-tool call, so the run recorder cannot see those
 * edits. Diffing the source tree records them on the run, where the guardian
 * can review them later. A copy of each source file taken before the run
 * lets a modified file show as a diff rather than as its whole new text.
 */
import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import {
  type FileChange,
  isSecretFile,
  MAX_CHANGE_CHARS,
  normalizePath,
  SECRET_PLACEHOLDER,
} from "./changes.js";

/** Build output, dependencies, and hidden folders (git, dream staging) are not source. Hidden files are. */
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);
/** Bounds one walk, so a huge apps directory cannot stall a dream. */
const MAX_FILES = 50_000;
/** Larger files are recorded by path only, and not copied. */
const MAX_READ_BYTES = 1_000_000;
/** Media and archives are never shown as text, so they are not copied. */
const BINARY_EXTENSIONS = new Set(
  "png jpg jpeg gif webp avif ico bmp svgz mp3 mp4 m4a wav ogg mov webm zip gz tgz pdf woff woff2 ttf otf sqlite db".split(
    " ",
  ),
);

export interface AppsSnapshot {
  /** Size and modification time of every source file. */
  files: Map<string, string>;
  /** Where the pre-run copies live, mirroring the apps directory. */
  copyDir: string;
}

async function walk(dir: string, visit: (path: string) => Promise<void>): Promise<void> {
  let count = 0;
  async function into(current: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= MAX_FILES) return;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)) await into(path);
      } else if (entry.isFile()) {
        count++;
        await visit(path);
      }
    }
  }
  await into(dir);
}

async function signatures(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  await walk(dir, async (path) => {
    const info = await stat(path).catch(() => null);
    if (info) files.set(path, `${info.size}:${info.mtimeMs}`);
  });
  return files;
}

/** Records every source file under `dir`, and copies the readable ones into `copyDir`. */
export async function snapshotApps(dir: string, copyDir: string): Promise<AppsSnapshot> {
  const files = await signatures(dir);
  for (const path of files.keys()) {
    if (BINARY_EXTENSIONS.has(extname(path).slice(1).toLowerCase())) continue;
    if (isSecretFile(path)) continue;
    const size = Number(files.get(path)?.split(":")[0]);
    if (size > MAX_READ_BYTES) continue;
    const copy = join(copyDir, relative(dir, path));
    try {
      await mkdir(dirname(copy), { recursive: true });
      // A clone where the filesystem supports it, a plain copy otherwise.
      await copyFile(path, copy, constants.COPYFILE_FICLONE);
    } catch {
      // Removed mid-walk, or unreadable: it shows as a whole-file write.
    }
  }
  return { files, copyDir };
}

export function attributeAppChanges(
  changes: FileChange[],
  practicePaths: ReadonlySet<string>,
): FileChange[] {
  const knownPaths = new Set([...practicePaths].map(normalizePath));
  return changes.map((change) => ({
    ...change,
    attribution: knownPaths.has(normalizePath(change.path)) ? "practice" : "unattributed",
  }));
}

/**
 * Files added, modified, or deleted since `before`: edits with their old text
 * when a copy exists, and a deletion as an edit to empty. This is the
 * authoritative record of a run's app changes: a file the agent also touched
 * with `Edit` shows its final state here too.
 */
export async function appChangesSince(dir: string, before: AppsSnapshot): Promise<FileChange[]> {
  const after = await signatures(dir);
  const changes: FileChange[] = [];
  for (const [path, signature] of after) {
    const previous = before.files.get(path);
    if (previous === signature) continue;
    if (isSecretFile(path)) {
      changes.push({
        op: "write",
        path,
        content: SECRET_PLACEHOLDER,
        previous: null,
        truncated: false,
      });
      continue;
    }
    const next = await readText(path);
    const old =
      previous === undefined ? null : await readText(join(before.copyDir, relative(dir, path)));
    if (next.text !== null && old?.text != null) {
      if (next.text === old.text) continue;
      changes.push({
        op: "edit",
        path,
        content: next.text.slice(0, MAX_CHANGE_CHARS),
        previous: old.text.slice(0, MAX_CHANGE_CHARS),
        truncated: next.truncated || old.truncated,
      });
    } else {
      changes.push({
        op: "write",
        path,
        content: next.text?.slice(0, MAX_CHANGE_CHARS) ?? next.note,
        previous: null,
        truncated: next.truncated,
      });
    }
  }
  // A walk cut short at MAX_FILES would make unvisited files look deleted.
  if (before.files.size >= MAX_FILES || after.size >= MAX_FILES) return changes;
  for (const path of before.files.keys()) {
    if (after.has(path)) continue;
    const old = isSecretFile(path)
      ? null
      : await readText(join(before.copyDir, relative(dir, path)));
    // A non-null previous text: an edit with none marks practice notes.
    changes.push({
      op: "edit",
      path,
      content: "",
      previous: old?.text?.slice(0, MAX_CHANGE_CHARS) ?? "(deleted; contents not recorded)",
      truncated: old?.truncated ?? false,
    });
  }
  return changes;
}

async function readText(
  path: string,
): Promise<{ text: string | null; note: string; truncated: boolean }> {
  try {
    const info = await stat(path);
    if (info.size > MAX_READ_BYTES) return { text: null, note: "", truncated: true };
    const buffer = await readFile(path);
    if (buffer.includes(0)) return { text: null, note: "(binary file)", truncated: false };
    const text = buffer.toString("utf8");
    return { text, note: "", truncated: text.length > MAX_CHANGE_CHARS };
  } catch {
    return { text: null, note: "", truncated: true };
  }
}
