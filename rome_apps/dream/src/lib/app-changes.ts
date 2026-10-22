/**
 * What a dream changed in the guardian's apps, found by comparing the apps
 * directory before and after the practice agent runs.
 *
 * The agent can change an app with Bash or through the coding agent, and
 * neither shows up as a file-tool call, so the run recorder cannot see those
 * edits. Diffing the source tree records them on the run, where the guardian
 * can review them later.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type FileChange, MAX_CHANGE_CHARS } from "./changes.js";

/** Build output, dependencies, and hidden folders (git, dream staging) are not source. */
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);
/** Bounds one walk, so a huge apps directory cannot stall a dream. */
const MAX_FILES = 50_000;
/** Larger files are recorded by path only. */
const MAX_READ_BYTES = 1_000_000;

export type AppsSnapshot = Map<string, string>;

/** Size and modification time of every source file under `dir`. */
export async function snapshotApps(dir: string): Promise<AppsSnapshot> {
  const files: AppsSnapshot = new Map();
  async function walk(current: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.size >= MAX_FILES) return;
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(path);
      } else if (entry.isFile()) {
        try {
          const info = await stat(path);
          files.set(path, `${info.size}:${info.mtimeMs}`);
        } catch {
          // Removed mid-walk.
        }
      }
    }
  }
  await walk(dir);
  return files;
}

/** Files added or modified since `before`, as writes of their new content. */
export async function appChangesSince(
  dir: string,
  before: AppsSnapshot,
  alreadyRecorded: ReadonlySet<string>,
): Promise<FileChange[]> {
  const after = await snapshotApps(dir);
  const changes: FileChange[] = [];
  for (const [path, signature] of after) {
    if (before.get(path) === signature || alreadyRecorded.has(path)) continue;
    changes.push(await asWrite(path));
  }
  return changes;
}

async function asWrite(path: string): Promise<FileChange> {
  try {
    const info = await stat(path);
    if (info.size > MAX_READ_BYTES) {
      return { op: "write", path, content: "", previous: null, truncated: true };
    }
    const buffer = await readFile(path);
    if (buffer.includes(0)) {
      return { op: "write", path, content: "(binary file)", previous: null, truncated: false };
    }
    const text = buffer.toString("utf8");
    return {
      op: "write",
      path,
      content: text.slice(0, MAX_CHANGE_CHARS),
      previous: null,
      truncated: text.length > MAX_CHANGE_CHARS,
    };
  } catch {
    return { op: "write", path, content: "", previous: null, truncated: true };
  }
}
