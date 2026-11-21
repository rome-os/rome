import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { describeRemovedWorktrees, removeStaleWorktrees } from "./stale-worktrees.js";

const DAY = 86_400_000;
/** Every worktree a test makes is a month old by this clock. */
const NOW = Date.now() + 30 * DAY;

let root: string;
let projects: string;
let apps: string;
let repo: string;
let lockfilePath: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeLockfile(sources: string[]): void {
  const entries = Object.fromEntries(
    sources.map((path, i) => [`app-${i}`, { source: { mode: "source", path } }]),
  );
  writeFileSync(lockfilePath, JSON.stringify({ schemaVersion: 3, apps: entries }));
}

/** A worktree of the app repo at `projects/<name>`, on a new branch or detached at main. */
function addWorktree(name: string, branch?: string): string {
  const path = join(projects, name);
  if (branch) git(repo, "worktree", "add", "-q", "-b", branch, path);
  else git(repo, "worktree", "add", "-q", "--detach", path, "main");
  return path;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "dream-worktrees-")));
  projects = join(root, "projects");
  apps = join(projects, "apps");
  repo = join(apps, "notes");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "app.yaml"), "id: notes\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  lockfilePath = join(root, "apps.lock.json");
  writeLockfile([repo]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("removeStaleWorktrees", () => {
  it("removes clean worktrees left behind, and keeps their branches", async () => {
    const feature = addWorktree("notes-csv-export", "task/csv-export");
    const install = addWorktree("notes-install-0.1.35");
    // Dependencies are ignored, so they do not make a worktree dirty.
    mkdirSync(join(feature, "node_modules/dep"), { recursive: true });
    writeFileSync(join(feature, "node_modules/dep/index.js"), "dep");

    const removed = await removeStaleWorktrees({ appsDir: apps, lockfilePath, now: NOW });

    expect(removed.map((w) => w.path).sort()).toEqual([install, feature].sort());
    expect(removed.find((w) => w.path === feature)?.branch).toBe("task/csv-export");
    expect(removed.find((w) => w.path === install)?.branch).toBeNull();
    expect(existsSync(feature)).toBe(false);
    expect(existsSync(install)).toBe(false);
    expect(git(repo, "branch", "--list", "task/csv-export")).toContain("task/csv-export");
    expect(existsSync(join(repo, "app.yaml"))).toBe(true);
  });

  it("keeps the worktree an app is installed from", async () => {
    const live = addWorktree("notes-live", "feature/live");
    writeLockfile([live]);

    expect(await removeStaleWorktrees({ appsDir: apps, lockfilePath, now: NOW })).toEqual([]);
    expect(existsSync(live)).toBe(true);
  });

  it("keeps a worktree with uncommitted changes or untracked files", async () => {
    const edited = addWorktree("notes-edited", "feature/edited");
    writeFileSync(join(edited, "app.yaml"), "id: notes\nversion: 0.2.0\n");
    const audited = addWorktree("notes-audited", "feature/audited");
    mkdirSync(join(audited, "audits/2026-11-09"), { recursive: true });
    writeFileSync(join(audited, "audits/2026-11-09/report.md"), "# Audit");

    expect(await removeStaleWorktrees({ appsDir: apps, lockfilePath, now: NOW })).toEqual([]);
    expect(existsSync(edited)).toBe(true);
    expect(existsSync(audited)).toBe(true);
  });

  it("keeps a worktree touched within the last week", async () => {
    const recent = addWorktree("notes-recent", "feature/recent");
    const touched = new Date(NOW - 2 * DAY);
    utimesSync(join(recent, "app.yaml"), touched, touched);

    expect(await removeStaleWorktrees({ appsDir: apps, lockfilePath, now: NOW })).toEqual([]);
    expect(existsSync(recent)).toBe(true);
  });

  it("keeps a detached worktree whose commit no branch or tag holds", async () => {
    const orphan = addWorktree("notes-orphan");
    writeFileSync(join(orphan, "fix.ts"), "export const fix = 1;");
    git(orphan, "add", ".");
    git(orphan, "commit", "-q", "-m", "fix on a detached HEAD");

    expect(await removeStaleWorktrees({ appsDir: apps, lockfilePath, now: NOW })).toEqual([]);
    expect(existsSync(orphan)).toBe(true);
  });

  it("keeps a worktree outside the projects folder", async () => {
    const elsewhere = join(root, "elsewhere");
    git(repo, "worktree", "add", "-q", "-b", "feature/elsewhere", elsewhere);

    expect(await removeStaleWorktrees({ appsDir: apps, lockfilePath, now: NOW })).toEqual([]);
    expect(existsSync(elsewhere)).toBe(true);
  });

  it("keeps a locked worktree", async () => {
    const locked = addWorktree("notes-locked", "feature/locked");
    git(repo, "worktree", "lock", locked);

    expect(await removeStaleWorktrees({ appsDir: apps, lockfilePath, now: NOW })).toEqual([]);
    expect(existsSync(locked)).toBe(true);
  });

  it("removes nothing when the lockfile cannot be read", async () => {
    const feature = addWorktree("notes-feature", "feature/x");
    rmSync(lockfilePath);

    expect(await removeStaleWorktrees({ appsDir: apps, lockfilePath, now: NOW })).toEqual([]);
    expect(existsSync(feature)).toBe(true);
  });

  it("finds the worktrees of an app repo in the projects folder", async () => {
    const outerRepo = join(projects, "dashboard");
    mkdirSync(outerRepo);
    git(outerRepo, "init", "-q", "-b", "main");
    git(outerRepo, "config", "user.email", "t@example.com");
    git(outerRepo, "config", "user.name", "Test");
    writeFileSync(join(outerRepo, "app.yaml"), "id: dashboard\n");
    git(outerRepo, "add", ".");
    git(outerRepo, "commit", "-q", "-m", "init");
    const emailEntry = join(projects, "dashboard-email-entry");
    git(outerRepo, "worktree", "add", "-q", "-b", "feature/email-entry", emailEntry);

    const removed = await removeStaleWorktrees({ appsDir: apps, lockfilePath, now: NOW });

    expect(removed.map((w) => w.path)).toEqual([emailEntry]);
    expect(existsSync(outerRepo)).toBe(true);
  });
});

describe("describeRemovedWorktrees", () => {
  it("names the removed folders in one line", () => {
    expect(describeRemovedWorktrees([])).toBe("");
    expect(
      describeRemovedWorktrees([
        { path: "/p/notes-a", branch: "a", head: "1" },
        { path: "/p/notes-b", branch: null, head: "2" },
      ]),
    ).toBe("Removed 2 finished app worktrees, keeping their commits: notes-a, notes-b.");
  });
});
