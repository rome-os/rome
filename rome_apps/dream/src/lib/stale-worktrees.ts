/**
 * Removes the git worktrees the guardian's chats left behind.
 *
 * An agent that changes an app often checks out a worktree per task or per
 * release (`notes-csv-export`, `notes-csv-export-install-0.1.35`), and
 * nothing removes it once the work lands. Each holds its own `node_modules`, so
 * dozens of them fill the disk, and they crowd the folders the guardian browses.
 *
 * A worktree is only a checkout of commits its repo keeps, so removing one
 * loses nothing when it is clean and its commit is on a branch or tag. The
 * repo and every branch stay. Removal is limited to worktrees nobody is using:
 * no installed app runs from it and nothing in it changed for a week.
 */
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** How long a worktree sits untouched before it counts as left behind. */
export const STALE_WORKTREE_DAYS = 7;

export interface RemovedWorktree {
  path: string;
  /** The branch it had checked out, or null when its HEAD was detached. */
  branch: string | null;
  head: string;
}

/** Core's app lockfile (`apps.lock.json`), which an app cannot import. */
export function profileLockfilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homedir(), ".rome", env.ROME_PROFILE || "default", "apps.lock.json");
}

/** Where every app in the lockfile is installed from, or null when the lockfile cannot be read. */
async function installedSources(lockfilePath: string): Promise<Set<string> | null> {
  try {
    const parsed = JSON.parse(await readFile(lockfilePath, "utf8")) as {
      apps?: Record<string, { source?: { path?: string } }>;
    };
    const sources = new Set<string>();
    for (const entry of Object.values(parsed.apps ?? {})) {
      const path = entry.source?.path;
      if (path) sources.add(await realpath(path).catch(() => path));
    }
    return sources;
  } catch {
    return null;
  }
}

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** App repos directly in `dir`: a folder with `app.yaml` and its own `.git` folder (not a worktree's `.git` file). */
async function appRepos(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const repos: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repo = join(dir, entry.name);
    if (!existsSync(join(repo, "app.yaml"))) continue;
    const dotGit = await stat(join(repo, ".git")).catch(() => null);
    if (dotGit?.isDirectory()) repos.push(repo);
  }
  return repos;
}

interface LinkedWorktree {
  path: string;
  head: string;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
}

/** The repo's linked worktrees, from `git worktree list --porcelain`, without its main one. */
async function linkedWorktrees(repo: string): Promise<LinkedWorktree[]> {
  const records = (await git(repo, ["worktree", "list", "--porcelain"])).trim().split(/\n\n+/);
  const worktrees: LinkedWorktree[] = [];
  for (const record of records.slice(1)) {
    const lines = record.split("\n");
    const field = (name: string) =>
      lines.find((line) => line === name || line.startsWith(`${name} `))?.slice(name.length + 1);
    const path = field("worktree");
    const head = field("HEAD");
    if (!path || !head) continue;
    const branch = field("branch");
    worktrees.push({
      path,
      head,
      branch: branch ? branch.replace(/^refs\/heads\//, "") : null,
      locked: field("locked") !== undefined,
      prunable: field("prunable") !== undefined,
    });
  }
  return worktrees;
}

/** The newest modification time under `dir`, skipping dependencies and git metadata. */
async function lastTouched(dir: string): Promise<number> {
  let newest = 0;
  async function into(current: string): Promise<void> {
    const info = await stat(current).catch(() => null);
    if (info && info.mtimeMs > newest) newest = info.mtimeMs;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await into(path);
      else if (entry.isFile()) {
        const file = await stat(path).catch(() => null);
        if (file && file.mtimeMs > newest) newest = file.mtimeMs;
      }
    }
  }
  await into(dir);
  return newest;
}

/** Whether removing the worktree keeps its commit: it is on a branch, or a branch or tag contains it. */
async function headIsKept(repo: string, worktree: LinkedWorktree): Promise<boolean> {
  if (worktree.branch) return true;
  const refs = await git(repo, [
    "for-each-ref",
    "--count=1",
    `--contains=${worktree.head}`,
    "refs/heads",
    "refs/tags",
  ]);
  return refs.trim() !== "";
}

/**
 * Removes every linked worktree of an app repo in `appsDir` or its parent
 * that is left behind: inside that parent, not installed, clean, its commit
 * kept by a branch or tag, and untouched for `staleDays`. Does nothing when
 * the lockfile cannot be read, since then any worktree could be installed.
 */
export async function removeStaleWorktrees(options: {
  appsDir: string;
  lockfilePath: string;
  now?: number;
  staleDays?: number;
}): Promise<RemovedWorktree[]> {
  const installed = await installedSources(options.lockfilePath);
  if (!installed) return [];
  const projectsDir = dirname(options.appsDir);
  const cutoff =
    (options.now ?? Date.now()) - (options.staleDays ?? STALE_WORKTREE_DAYS) * 86_400_000;
  const repos = [...(await appRepos(options.appsDir)), ...(await appRepos(projectsDir))];

  const removed: RemovedWorktree[] = [];
  for (const repo of repos) {
    let worktrees: LinkedWorktree[];
    try {
      worktrees = await linkedWorktrees(repo);
    } catch {
      continue;
    }
    for (const worktree of worktrees) {
      if (worktree.locked || worktree.prunable) continue;
      const path = await realpath(worktree.path).catch(() => null);
      if (!path || !inside(projectsDir, path)) continue;
      if ([...installed].some((source) => inside(path, source))) continue;
      try {
        // Untracked files count: an agent's audit output is often never committed.
        const status = await git(path, ["status", "--porcelain", "--untracked-files=all"]);
        if (status.trim() !== "") continue;
        if ((await lastTouched(path)) > cutoff) continue;
        if (!(await headIsKept(repo, worktree))) continue;
        // Without --force, git itself refuses a worktree that is not clean.
        await git(repo, ["worktree", "remove", worktree.path]);
      } catch {
        continue;
      }
      removed.push({ path: worktree.path, branch: worktree.branch, head: worktree.head });
    }
  }
  return removed;
}

/** One line for the run summary, or an empty string when nothing was removed. */
export function describeRemovedWorktrees(removed: RemovedWorktree[]): string {
  if (removed.length === 0) return "";
  const names = removed.map((w) => w.path.split("/").pop()).join(", ");
  const noun = removed.length === 1 ? "worktree" : "worktrees";
  return `Removed ${removed.length} finished app ${noun}, keeping their commits: ${names}.`;
}
