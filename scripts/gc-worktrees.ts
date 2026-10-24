#!/usr/bin/env tsx
/**
 * Garbage-collect worktrees whose branches have been merged into main,
 * along with the dev-stack artifacts they pinned:
 *
 *   - the per-worktree Compose project (image, containers, named volumes)
 *   - the per-worktree home dir at ~/.rome-worktrees/<slug>
 *   - the worktree directory and its local branch
 *
 * Prints a report, then prompts for confirmation before executing.
 * Pass --yes to skip the prompt (non-interactive use).
 *
 * A worktree is eligible when ALL of:
 *   - it is not the main worktree
 *   - it is not the worktree this script is being run from
 *   - HEAD is on a branch (not detached)
 *   - it is not locked by an active claude agent. Locks whose `(pid N)`
 *     in the lock reason point to a dead process are treated as stale
 *     and auto-reclaimed (`git worktree unlock` runs before remove).
 *     Pass --include-locked to bypass the live-PID check entirely.
 *   - the working tree is clean (no modified or untracked files)
 *   - the branch is "merged": has a PR in state "merged" on GitHub (the
 *     squash-merge case, which is what this repo uses), or — as a
 *     fallback when gh is unavailable / no PR — its SHA is strictly
 *     behind origin/main. A branch sitting at exactly origin/main HEAD
 *     with no PR is a "stub" (created but never committed to) and is
 *     skipped, because GC'ing it would surprise a user who's about to
 *     start work.
 *
 * It looks a worktree's stack and home dir up by the worktree directory's
 * name (#1314), and removes them only when that stack was started from this
 * worktree and is not the one ROME_DEV_SLUG pins (see
 * scripts/gc-stack-guard.ts).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

import { checkbox } from "@inquirer/prompts";

import { mayTearDownStack, OWNER_FILE, pinnedSlug, slugify } from "./gc-stack-guard.js";

// Types

interface Flags {
  yes: boolean;
  includeLocked: boolean;
  force: boolean;
}

interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  locked: boolean;
  lockReason: string | null;
}

type SkipReason =
  | "MAIN"
  | "CURRENT"
  | "DETACHED"
  | "LOCKED"
  | "PRUNABLE"
  | "DIRTY"
  | "STUB"
  | "UNMERGED";

interface Eligible {
  kind: "ELIGIBLE";
  worktree: Worktree;
  branch: string;
  slug: string;
  actions: string; // e.g. "·DOHWB" or "··O·WB" — char per step
  rmRomeHome: boolean;
  hasCompose: boolean;
  /** A home dir gc keeps because it cannot prove this worktree owns it. */
  keptHome: string | null;
  locked: boolean; // needs `git worktree unlock` before remove
}

interface Skipped {
  kind: "SKIP";
  worktree: Worktree;
  reason: SkipReason;
  base: string;
  // Populated only for DIRTY: the merge state of the branch, plus a
  // summary of how dirty the worktree is. Used by the post-apply
  // "review dirty" checkbox flow.
  mergeState?: BranchState;
  dirty?: { modified: number; untracked: number };
}

type Classified = Eligible | Skipped;

interface Ctx {
  mainWorktree: string;
  currentWorktree: string;
  originMainSha: string;
  flags: Flags;
}

// Small subprocess helpers

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  return run("git", args, { cwd });
}

function gitOut(args: string[], cwd: string): string {
  const r = git(args, cwd);
  if (!r.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

// Flag parsing

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { yes: false, includeLocked: false, force: false };
  for (const a of argv) {
    switch (a) {
      case "-y":
      case "--yes":
        flags.yes = true;
        break;
      case "--include-locked":
        flags.includeLocked = true;
        break;
      case "--force":
        flags.force = true;
        break;
      case "-h":
      case "--help":
        process.stderr.write(USAGE);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        process.stderr.write(`gc-worktrees: unknown arg: ${a}\n${USAGE}`);
        process.exit(2);
    }
  }
  return flags;
}

const USAGE = `Usage: pnpm gc:worktrees [-y|--yes] [--include-locked] [--force]

  -y, --yes         Skip the confirmation prompt (non-interactive).
  --include-locked  Also consider locked worktrees (e.g. agent-* ones).
  --force           Pass --force to git worktree remove (overrides
                    untracked/modified file safety check).
`;

// Stack ownership. gc looks a worktree's stack up by the worktree directory's
// name, which can differ from the name dev-up.sh gave it (#1314). Before it
// removes that stack it checks who started it (gc-stack-guard.ts).

let warnedDockerUnreachable = false;

/** The owner file's content in the stack `slug`'s home dir, or null. */
function stackOwner(slug: string): string | null {
  try {
    return (
      readFileSync(join(homedir(), ".rome-worktrees", slug, OWNER_FILE), "utf8")
        .split("\n")[0]
        .trim() || null
    );
  } catch {
    return null;
  }
}

/** The compose working directory of each container in the stack `slug`, or
 *  null when Docker could not be asked. */
function stackOwnerDirs(slug: string): string[] | null {
  const r = run("docker", [
    "ps",
    "-a",
    "--filter",
    `label=com.docker.compose.project=${slug}`,
    "--format",
    '{{.Label "com.docker.compose.project.working_dir"}}',
  ]);
  if (!r.ok) {
    if (!warnedDockerUnreachable) {
      warnedDockerUnreachable = true;
      console.warn(
        "docker is unreachable, so every stack and its home dir is kept. Run gc again once Docker is up.",
      );
    }
    return null;
  }
  return [
    ...new Set(
      r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

/** The stack actions gc may take for a worktree, after the ownership check. */
function stackActions(
  slug: string,
  worktreePath: string,
): { hasCompose: boolean; rmRomeHome: boolean; keptHome: string | null } {
  const owner = stackOwner(slug);
  const owned = mayTearDownStack({
    slug,
    worktreePath,
    pinned: pinnedSlug(process.env),
    owner,
    ownerDirs: stackOwnerDirs(slug),
  });
  const home = join(homedir(), ".rome-worktrees", slug);
  const homeExists = existsSync(home);
  return {
    hasCompose: owned && existsSync(join(worktreePath, "compose.dev.yml")),
    rmRomeHome: owned && homeExists,
    keptHome: !owned && homeExists ? home : null,
  };
}

// Worktree discovery

function listWorktrees(mainWorktree: string): Worktree[] {
  const out = gitOut(["worktree", "list", "--porcelain"], mainWorktree);
  const result: Worktree[] = [];
  let cur: Partial<Worktree> = {};
  const flush = () => {
    if (cur.path) {
      result.push({
        path: cur.path,
        head: cur.head ?? "",
        branch: cur.branch ?? null,
        locked: cur.locked ?? false,
        lockReason: cur.lockReason ?? null,
      });
    }
    cur = {};
  };
  for (const line of out.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) cur.path = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch refs/heads/"))
      cur.branch = line.slice("branch refs/heads/".length);
    else if (line === "detached") cur.branch = null;
    else if (line.startsWith("locked")) {
      cur.locked = true;
      const rest = line.slice("locked".length).trim();
      cur.lockReason = rest || null;
    }
  }
  flush();
  return result;
}

// Lock-reason format from porcelain is free-form, but the claude-code
// worktree skill writes "claude agent <slug> (pid <N>)". Pull the PID
// out so we can check whether the agent that took the lock is gone.
function parseLockedPid(reason: string | null): number | null {
  if (!reason) return null;
  const m = reason.match(/\(pid (\d+)\)/);
  return m ? Number(m[1]) : null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true; // EPERM or other: assume alive (safer to skip than to GC).
  }
}

// Branch classification

type BranchState = "MERGED" | "STUB" | "UNMERGED";

function summarizeDirty(stdout: string): { modified: number; untracked: number } {
  let modified = 0;
  let untracked = 0;
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("??")) untracked++;
    else modified++;
  }
  return { modified, untracked };
}

function classifyBranch(branch: string, sha: string, ctx: Ctx): BranchState {
  // 1) Merged PR on GitHub — covers squash-merge (this repo's default).
  if (which("gh")) {
    const r = run("gh", [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "merged",
      "--limit",
      "1",
      "--json",
      "number",
      "--jq",
      ".[0].number",
    ]);
    if (r.ok) {
      const n = r.stdout.trim();
      if (n && n !== "null") return "MERGED";
    }
  }
  // 2) Branch sits at exactly origin/main HEAD with no PR — stub.
  if (sha === ctx.originMainSha) return "STUB";
  // 3) Strictly behind origin/main — covers non-squash merges.
  const anc = git(["merge-base", "--is-ancestor", sha, ctx.originMainSha], ctx.mainWorktree);
  if (anc.ok) return "MERGED";
  return "UNMERGED";
}

function which(cmd: string): boolean {
  return run("sh", ["-c", `command -v ${cmd} >/dev/null 2>&1`]).ok;
}

// Worktree → eligibility / skip reason

function classify(wt: Worktree, ctx: Ctx): Classified {
  const base = basename(wt.path);
  const skip = (reason: SkipReason): Skipped => ({ kind: "SKIP", worktree: wt, reason, base });

  if (wt.path === ctx.mainWorktree) return skip("MAIN");
  if (wt.path === ctx.currentWorktree) return skip("CURRENT");
  if (!wt.branch) return skip("DETACHED");
  if (wt.locked && !ctx.flags.includeLocked) {
    // Stale claude-agent locks (PID dead) reclaim automatically; live
    // locks (or unparseable reasons) still skip.
    const pid = parseLockedPid(wt.lockReason);
    if (pid === null || isPidAlive(pid)) return skip("LOCKED");
  }
  if (!existsSync(wt.path)) return skip("PRUNABLE");

  // git status --porcelain catches untracked too — load-bearing, because
  // git worktree remove blocks on untracked, not just modified.
  const status = git(["status", "--porcelain", "--ignore-submodules"], wt.path);
  if (!status.ok || status.stdout.trim() !== "") {
    // Stash merge state + dirty summary so the post-apply "review dirty"
    // flow can offer to force-clean dirty-but-merged worktrees.
    const dirtyInfo = summarizeDirty(status.stdout);
    const mergeState = classifyBranch(wt.branch, wt.head, ctx);
    return { ...skip("DIRTY"), mergeState, dirty: dirtyInfo };
  }

  const state = classifyBranch(wt.branch, wt.head, ctx);
  if (state === "STUB") return skip("STUB");
  if (state === "UNMERGED") return skip("UNMERGED");

  const slug = slugify(base);
  const { hasCompose, rmRomeHome, keptHome } = stackActions(slug, wt.path);
  const actions =
    (wt.locked ? "L" : "·") + (hasCompose ? "D" : "·") + (rmRomeHome ? "H" : "·") + "WB";

  return {
    kind: "ELIGIBLE",
    worktree: wt,
    branch: wt.branch,
    slug,
    actions,
    rmRomeHome,
    hasCompose,
    keptHome,
    locked: wt.locked,
  };
}

// Report rendering

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function wrapList(prefix: string, indent: string, items: string[], width = 78): string[] {
  const lines: string[] = [];
  let line = prefix;
  let first = true;
  for (const w of items) {
    const sep = first ? "" : ", ";
    if (line.length > 0 && line.length + sep.length + w.length > width) {
      lines.push(line);
      line = indent + w;
    } else {
      line = line + sep + w;
    }
    first = false;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function renderReport(eligible: Eligible[], skipped: Skipped[]): void {
  if (eligible.length > 0) {
    console.log(`\nELIGIBLE (${eligible.length}) — clean with --yes (or confirm prompt)`);
    for (const e of eligible) {
      console.log(`  [${e.actions}]  ${pad(e.slug, 38)}  ${e.branch}`);
    }
  }

  const grouped: Record<SkipReason, string[]> = {
    LOCKED: [],
    UNMERGED: [],
    STUB: [],
    DIRTY: [],
    PRUNABLE: [],
    DETACHED: [],
    MAIN: [],
    CURRENT: [],
  };
  for (const s of skipped) grouped[s.reason].push(s.base);

  const total = skipped.length;
  if (total > 0) {
    console.log(`\nSKIPPED (${total})`);
    const row = (count: number, label: string, hint = ""): string =>
      `  ${String(count).padStart(3)}  ${pad(label, 22)}  ${hint}`;

    if (grouped.LOCKED.length > 0)
      console.log(row(grouped.LOCKED.length, "locked (active)", "(--include-locked to scan)"));
    if (grouped.UNMERGED.length > 0) console.log(row(grouped.UNMERGED.length, "branch not merged"));
    if (grouped.STUB.length > 0)
      for (const l of wrapList(
        row(grouped.STUB.length, "stub (= origin/main)"),
        " ".repeat(32),
        grouped.STUB,
      ))
        console.log(l);
    if (grouped.DIRTY.length > 0)
      for (const l of wrapList(
        row(grouped.DIRTY.length, "dirty working tree"),
        " ".repeat(32),
        grouped.DIRTY,
      ))
        console.log(l);
    if (grouped.PRUNABLE.length > 0) {
      for (const l of wrapList(
        row(grouped.PRUNABLE.length, "path missing"),
        " ".repeat(32),
        grouped.PRUNABLE,
      ))
        console.log(l);
      console.log("       (run: git worktree prune)");
    }
    if (grouped.DETACHED.length > 0) console.log(row(grouped.DETACHED.length, "detached HEAD"));
    if (grouped.MAIN.length > 0) console.log(row(1, "main worktree"));
    if (grouped.CURRENT.length > 0) console.log(row(1, "current worktree"));
  }

  if (eligible.length > 0) {
    const reclaimed = eligible.filter((e) => e.locked).length;
    if (reclaimed > 0) {
      console.log(`\n  Reclaimed ${reclaimed} stale lock(s) — owning claude agent PID is gone.`);
    }
    console.log(`
Legend  L=git worktree unlock      D=docker compose down -v
        H=rm rome-home             W=git worktree remove
        B=git branch -D            ·=skipped
`);
    const kept = eligible.filter((e) => e.keptHome !== null);
    if (kept.length > 0) {
      console.log(
        "Kept, since gc cannot prove these worktrees started them. Remove by hand if unused:",
      );
      for (const e of kept) console.log(`  ${e.slug.padEnd(30)} ${e.keptHome}`);
      console.log("");
    }
  }
}

// Apply phase

interface StepResult {
  ok: boolean;
  err?: string;
}

function step(label: string, r: { ok: boolean; stderr: string }): StepResult {
  if (r.ok) {
    process.stdout.write(` ${label} ✓`);
    return { ok: true };
  }
  process.stdout.write(` ${label} ✗`);
  const err = r.stderr.trim().replace(/\s+/g, " ");
  process.stdout.write(`\n      ! ${label}: ${err}\n`);
  return { ok: false, err };
}

function rmHome(slug: string): StepResult {
  const dir = join(homedir(), ".rome-worktrees", slug);
  if (!existsSync(dir)) {
    process.stdout.write(" home ✓");
    return { ok: true };
  }
  // Try host-side first.
  const hostRm = run("rm", ["-rf", dir]);
  if (hostRm.ok) {
    process.stdout.write(" home ✓");
    return { ok: true };
  }
  // Containers run as root; fall back to deleting from inside an alpine
  // container that shares the same host mount.
  const dockerRm = run("docker", [
    "run",
    "--rm",
    "-v",
    `${join(homedir(), ".rome-worktrees")}:/x`,
    "alpine",
    "rm",
    "-rf",
    `/x/${slug}`,
  ]);
  if (dockerRm.ok) {
    process.stdout.write(" home ✓(docker)");
    return { ok: true };
  }
  const err = (dockerRm.stderr || hostRm.stderr).trim().replace(/\s+/g, " ");
  process.stdout.write(" home ✗\n      ! home: " + err + "\n");
  return { ok: false, err };
}

function buildComposeEnv(slug: string): NodeJS.ProcessEnv {
  // compose.dev.yml has `${ROME_HOST_PNPM_STORE:?…}` etc., interpolated
  // even on `down`. Resolve the same vars dev-up.sh exports.
  const env: NodeJS.ProcessEnv = { ...process.env, ROME_WORKTREE_SLUG: slug };
  if (!env.ROME_HOST_PNPM_STORE) {
    const r = run("pnpm", ["store", "path"]);
    if (r.ok) env.ROME_HOST_PNPM_STORE = dirname(r.stdout.trim());
  }
  if (!env.ROME_HOST_UID) env.ROME_HOST_UID = String(process.getuid?.() ?? 0);
  if (!env.ROME_HOST_GID) env.ROME_HOST_GID = String(process.getgid?.() ?? 0);
  return env;
}

function applyOne(
  e: Eligible,
  ctx: Ctx,
  idx: number,
  total: number,
  forceOverride = false,
): boolean {
  process.stdout.write(`  [${idx + 1}/${total}] ${e.slug} `);
  let fail = false;
  const forceRemove = forceOverride || ctx.flags.force;

  if (e.hasCompose) {
    const env = buildComposeEnv(e.slug);
    const r = run(
      "docker",
      [
        "compose",
        "--project-directory",
        e.worktree.path,
        "-f",
        join(e.worktree.path, "compose.dev.yml"),
        "-p",
        e.slug,
        "down",
        "-v",
        "--rmi",
        "local",
        "--remove-orphans",
      ],
      { env },
    );
    if (!step("docker", r).ok) fail = true;
  }

  if (e.rmRomeHome) {
    if (!rmHome(e.slug).ok) fail = true;
  }

  if (e.locked) {
    // git worktree remove refuses on locked worktrees without --force;
    // unlocking explicitly keeps error reporting separate from the
    // remove step and avoids forcing through other safety checks.
    const unlock = git(["worktree", "unlock", e.worktree.path], ctx.mainWorktree);
    if (!step("unlock", unlock).ok) fail = true;
  }

  const removeArgs = ["worktree", "remove"];
  if (forceRemove) removeArgs.push("--force");
  removeArgs.push(e.worktree.path);
  const wtR = git(removeArgs, ctx.mainWorktree);
  const wtRemoved = step("worktree", wtR).ok;
  if (!wtRemoved) fail = true;

  // git refuses to delete a branch still backing a worktree, so skip if
  // we couldn't remove the worktree — the message would just be noise.
  if (wtRemoved) {
    const br = git(["branch", "-D", e.branch], ctx.mainWorktree);
    if (!step("branch", br).ok) fail = true;
  }

  process.stdout.write("\n");
  return !fail;
}

// Dirty-but-merged review (force-clean opt-in via checkbox TUI)

function dirtyToEligible(s: Skipped): Eligible {
  if (s.reason !== "DIRTY" || !s.worktree.branch) {
    throw new Error("dirtyToEligible: not a dirty worktree with a branch");
  }
  const slug = slugify(s.base);
  const { hasCompose, rmRomeHome, keptHome } = stackActions(slug, s.worktree.path);
  const actions =
    (s.worktree.locked ? "L" : "·") + (hasCompose ? "D" : "·") + (rmRomeHome ? "H" : "·") + "WB";
  return {
    kind: "ELIGIBLE",
    worktree: s.worktree,
    branch: s.worktree.branch,
    slug,
    actions,
    rmRomeHome,
    hasCompose,
    keptHome,
    locked: s.worktree.locked,
  };
}

async function reviewDirty(skipped: Skipped[], ctx: Ctx): Promise<Eligible[]> {
  // Only dirty worktrees whose branch is fully merged are safe to offer
  // for force-clean. Dirty + unmerged or dirty + stub keeps real work,
  // and the user should resolve those manually.
  const candidates = skipped.filter(
    (s): s is Skipped & { mergeState: "MERGED"; dirty: { modified: number; untracked: number } } =>
      s.reason === "DIRTY" && s.mergeState === "MERGED" && s.dirty !== undefined,
  );
  if (candidates.length === 0) return [];

  if (ctx.flags.yes) {
    // In non-interactive mode the user opted out of any review;
    // dirty merged worktrees stay skipped. They can re-run interactively.
    console.log(
      `\n${candidates.length} dirty merged worktree(s) skipped. Re-run interactively to review.`,
    );
    return [];
  }
  if (!process.stdin.isTTY) return [];

  console.log(
    `\n${candidates.length} dirty worktree(s) have merged branches. Select to force-clean (uncommitted changes will be lost):`,
  );

  const choices = candidates.map((c) => {
    const d = c.dirty;
    const summary = `${d.modified} modified, ${d.untracked} untracked`;
    return {
      name: `${c.base.padEnd(46)}  ${summary}`,
      value: c,
      short: c.base,
    };
  });

  const selected = await checkbox({
    message: "Force-clean which? (space=toggle, a=all, i=invert, enter=confirm)",
    choices,
    loop: false,
  });

  if (selected.length === 0) {
    console.log("None selected. Dirty worktrees left alone.");
    return [];
  }

  return selected.map(dirtyToEligible);
}

// Confirmation

async function confirm(eligible: number, flags: Flags): Promise<boolean> {
  if (flags.yes) {
    console.log("--yes given — proceeding without prompt.");
    return true;
  }
  if (!process.stdin.isTTY) {
    console.error("stdin is not a tty — pass --yes to confirm non-interactively.");
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`Proceed with cleanup of ${eligible} worktree(s)? [y/N] `);
    return /^(y|yes)$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

// Main

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  const repoRoot = gitOut(["rev-parse", "--show-toplevel"], process.cwd());
  const gitCommonDir = gitOut(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    repoRoot,
  );
  const mainWorktree = dirname(gitCommonDir);

  console.error("fetching origin/main...");
  const fetch = git(["fetch", "--quiet", "origin", "main"], mainWorktree);
  if (!fetch.ok) {
    console.error(`fetch failed: ${fetch.stderr.trim()}`);
    process.exit(1);
  }
  const originMainSha = gitOut(["rev-parse", "origin/main"], mainWorktree);

  const ctx: Ctx = {
    mainWorktree,
    currentWorktree: repoRoot,
    originMainSha,
    flags,
  };

  const worktrees = listWorktrees(mainWorktree);
  const classified = worktrees.map((w) => classify(w, ctx));
  const eligible = classified.filter((c): c is Eligible => c.kind === "ELIGIBLE");
  const skipped = classified.filter((c): c is Skipped => c.kind === "SKIP");

  renderReport(eligible, skipped);

  const dirtyMergedCount = skipped.filter(
    (s) => s.reason === "DIRTY" && s.mergeState === "MERGED",
  ).length;

  if (eligible.length === 0 && dirtyMergedCount === 0) {
    console.log("Nothing to do.");
    return;
  }

  let successes = 0;
  let attempts = 0;

  if (eligible.length > 0) {
    const ok = await confirm(eligible.length, flags);
    if (!ok) {
      console.log("Aborted.");
      return;
    }
    console.log(`\nAPPLYING (${eligible.length})`);
    for (let i = 0; i < eligible.length; i++) {
      attempts++;
      if (applyOne(eligible[i], ctx, i, eligible.length)) successes++;
    }
  }

  const dirtyExtras = await reviewDirty(skipped, ctx);
  if (dirtyExtras.length > 0) {
    console.log(`\nAPPLYING dirty (${dirtyExtras.length}, --force)`);
    for (let i = 0; i < dirtyExtras.length; i++) {
      attempts++;
      if (applyOne(dirtyExtras[i], ctx, i, dirtyExtras.length, true)) successes++;
    }
  }

  // Tidy stale administrative refs after potential removals.
  git(["worktree", "prune"], ctx.mainWorktree);

  const failures = attempts - successes;
  console.log("");
  if (attempts === 0) {
    console.log("Nothing applied.");
    return;
  }
  if (failures > 0) {
    console.log(`Done with ${failures} failure(s) out of ${attempts}.`);
    process.exit(1);
  }
  console.log(`Done. Cleaned ${attempts} worktree(s).`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
