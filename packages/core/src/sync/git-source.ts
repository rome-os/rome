import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  OAUTH_PROVIDER_GRANTS,
  githubGrantProfileSchema,
  type GithubGrantProfile,
} from "../connections/integrations/oauth-providers.js";
import { DrizzleGrantLedger } from "../connections/ledger-db.js";
import { readGithubAccessTokenFile } from "../lib/provider-token-files.js";
import { createLogger } from "../logger.js";
import type { DrizzleDb } from "../db/index.js";
import type {
  ChangeDiff,
  ChangedFile,
  LinkExtra,
  LinkOutcome,
  LinkStrategy,
  RemoteTarget,
  RemoteTargetCandidate,
  SyncAvailability,
  SyncGroup,
  SyncOutcome,
  SyncSource,
  SyncSourceDescriptor,
  SyncStatus,
} from "./types.js";

const log = createLogger("sync:git");

const GITHUB_API = "https://api.github.com";

const execFileAsync = promisify(execFile);
// Local probes are fast; network ops (fetch/push/ls-remote) can take a while on
// big repos or slow links. Both are bounded so a hung git never blocks forever.
const LOCAL_GIT_TIMEOUT_MS = 10_000;
const NETWORK_GIT_TIMEOUT_MS = 60_000;
const MAX_DIFF_CHARS = 500_000;

/**
 * The git source's `project_link_extra` shape. `url` + `defaultBranch` are the
 * target identity (recovery hint if `.git` is lost — `.git` is authoritative
 * when present). `initialStrategy` is a one-time record of how the first link
 * reconciled. `private` / `lastSyncedAt` are small source-owned caches with no
 * local SSOT, refreshed on sync.
 */
type GitLinkExtra = {
  url: string;
  defaultBranch: string;
  initialStrategy?: LinkStrategy;
  private?: boolean;
  lastSyncedAt?: string;
};

function decodeGitExtra(extra: LinkExtra): GitLinkExtra {
  const url = typeof extra.url === "string" ? extra.url : "";
  const defaultBranch =
    typeof extra.defaultBranch === "string" && extra.defaultBranch ? extra.defaultBranch : "main";
  return {
    url,
    defaultBranch,
    initialStrategy:
      typeof extra.initialStrategy === "string"
        ? (extra.initialStrategy as LinkStrategy)
        : undefined,
    private: typeof extra.private === "boolean" ? extra.private : undefined,
    lastSyncedAt: typeof extra.lastSyncedAt === "string" ? extra.lastSyncedAt : undefined,
  };
}

/** Read the target identity (url + branch) chosen at selection time. */
function readTargetIdentity(target: RemoteTarget): {
  url: string;
  defaultBranch: string;
  private?: boolean;
} {
  const url = typeof target.locator.url === "string" ? target.locator.url : "";
  const defaultBranch =
    typeof target.locator.defaultBranch === "string" && target.locator.defaultBranch
      ? target.locator.defaultBranch
      : "main";
  if (!url) throw new Error("Target is missing a repository URL");
  return {
    url,
    defaultBranch,
    private: typeof target.locator.private === "boolean" ? target.locator.private : undefined,
  };
}

function labelFromUrl(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/\.git$/, "")
    .replace(":", "/");
}

/** Extract "owner/repo" from a GitHub remote URL (https or ssh form). */
function repoFullNameFromUrl(url: string): string | null {
  const match = url.match(/github\.com[/:](.+?)(?:\.git)?$/i);
  return match ? match[1] : null;
}

/** Run git asynchronously (never blocks the event loop) with a timeout. Network
 * ops to github.com authenticate through the gh credential helper that
 * `gh auth setup-git` installs at OAuth time, so no token is ever passed on the
 * command line (it would be world-readable via `/proc/<pid>/cmdline` / `ps`). */
async function git(
  dir: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: dir,
    encoding: "utf-8",
    timeout: opts.timeoutMs ?? LOCAL_GIT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer,
    windowsHide: true,
  });
  return stdout;
}

/** Run git, returning null instead of throwing — for read-only probes. */
async function tryGit(
  dir: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<string | null> {
  try {
    return await git(dir, args, opts);
  } catch {
    return null;
  }
}

/** `git diff --no-index` uses exit code 1 to mean "differences found". Keep
 * that stdout while still surfacing genuine command failures. */
async function gitDiff(dir: string, args: string[]): Promise<string> {
  try {
    return await git(dir, args, { maxBuffer: MAX_DIFF_CHARS * 20 });
  } catch (error) {
    const result = error as { code?: number; stdout?: string };
    if (result.code === 1 && typeof result.stdout === "string") return result.stdout;
    throw error;
  }
}

function hasGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** Local "has content" = any entry other than the git dir. */
function localHasContent(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((entry) => entry !== ".git");
}

async function remoteHasContent(dir: string, url: string): Promise<boolean> {
  const out = await tryGit(dir, ["ls-remote", url], { timeoutMs: NETWORK_GIT_TIMEOUT_MS });
  return !!out && out.trim().length > 0;
}

// Always expand untracked directories so every entry returned to the web app
// is a real file that can be inspected and undone independently.
const STATUS_PORCELAIN_ARGS = ["status", "--porcelain", "-z", "--untracked-files=all"];

/** Parse `git status --porcelain -z` into a flat list of changed files, classifying
 * each into the same three buckets `countChanges` totals. Renames/copies render
 * destination first in z-format; we report that destination path. Exported for
 * unit tests. */
export function parseChanges(porcelainZ: string): ChangedFile[] {
  return parseChangeEntries(porcelainZ).map(({ originalPath: _originalPath, ...file }) => file);
}

type GitChangeEntry = ChangedFile & { originalPath?: string };

function parseChangeEntries(porcelainZ: string): GitChangeEntry[] {
  const files: GitChangeEntry[] = [];
  const records = porcelainZ.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    const originalPath = code.includes("R") || code.includes("C") ? records[++i] : undefined;
    const change: ChangedFile["change"] =
      code === "??" || code.includes("A") ? "added" : code.includes("D") ? "removed" : "modified";
    files.push({ path, change, originalPath });
  }
  return files;
}

function resolveChangePath(projectDir: string, path: string): { path: string; absolute: string } {
  const normalized = path.replace(/\/+$/, "");
  if (
    !normalized ||
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized.startsWith(".git\\")
  ) {
    throw new Error("Invalid change path");
  }
  const root = resolve(projectDir);
  const absolute = resolve(root, normalized);
  const fromRoot = relative(root, absolute);
  if (!fromRoot || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Invalid change path");
  }
  return { path: normalized, absolute };
}

/** Remove empty directories left behind after deleting an untracked file.
 * `rmdirSync` remains race-safe: if a sibling appears between the emptiness
 * check and removal, it fails without deleting that new content. */
function pruneEmptyParents(projectDir: string, deletedPath: string): void {
  const root = resolve(projectDir);
  let current = dirname(deletedPath);
  while (current !== root) {
    if (!existsSync(current) || readdirSync(current).length > 0) return;
    try {
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

/** Restore one status entry to HEAD. Added paths are removed; tracked paths are
 * checked out from the baseline. Rename pairs are handled together so the old
 * path is restored and the new path is removed. */
export async function restoreGitChange(projectDir: string, requestedPath: string): Promise<void> {
  if (!hasGitRepo(projectDir)) throw new Error("Project is not a Git repository");
  const porcelain = (await tryGit(projectDir, STATUS_PORCELAIN_ARGS)) ?? "";
  const entry = parseChangeEntries(porcelain).find((candidate) => candidate.path === requestedPath);
  if (!entry) throw new Error("That file no longer has local changes");

  const targets = [entry.path, entry.originalPath].filter((path): path is string => !!path);
  const safeTargets = targets.map((path) => resolveChangePath(projectDir, path));

  // Reset the index first so staged changes do not survive the working-tree restore.
  // This may fail for an unborn branch, where every listed path is necessarily added.
  await tryGit(projectDir, ["reset", "-q", "HEAD", "--", ...safeTargets.map((item) => item.path)]);

  for (const target of safeTargets) {
    const trackedAtHead =
      (await tryGit(projectDir, ["cat-file", "-e", `HEAD:${target.path}`])) !== null;
    if (trackedAtHead) {
      await git(projectDir, ["checkout", "HEAD", "--", target.path]);
    } else {
      rmSync(target.absolute, { recursive: true, force: true });
      pruneEmptyParents(projectDir, target.absolute);
    }
  }
}

/** Restore every current status entry to HEAD. Re-read status through the
 * single-file helper on each pass so rename pairs and nested untracked paths
 * retain the same validation and cleanup behavior as an individual restore. */
export async function restoreAllGitChanges(projectDir: string): Promise<void> {
  if (!hasGitRepo(projectDir)) throw new Error("Project is not a Git repository");
  const porcelain = (await tryGit(projectDir, STATUS_PORCELAIN_ARGS)) ?? "";
  for (const entry of parseChangeEntries(porcelain)) {
    await restoreGitChange(projectDir, entry.path);
  }
}

/** Return the real unified patch for one current status entry. Tracked paths
 * compare HEAD with both staged and unstaged work; untracked paths compare
 * against an empty file without modifying the index. */
export async function getGitChangeDiff(
  projectDir: string,
  requestedPath: string,
): Promise<ChangeDiff> {
  if (!hasGitRepo(projectDir)) throw new Error("Project is not a Git repository");
  const porcelain = (await tryGit(projectDir, STATUS_PORCELAIN_ARGS)) ?? "";
  const entry = parseChangeEntries(porcelain).find((candidate) => candidate.path === requestedPath);
  if (!entry) throw new Error("That file no longer has local changes");

  const safe = resolveChangePath(projectDir, entry.path);
  const trackedAtHead =
    (await tryGit(projectDir, ["cat-file", "-e", `HEAD:${safe.path}`])) !== null;
  const patch =
    trackedAtHead || entry.originalPath
      ? await gitDiff(projectDir, [
          "diff",
          "--no-ext-diff",
          "--no-color",
          "--find-renames",
          "HEAD",
          "--",
          entry.originalPath ?? safe.path,
          safe.path,
        ])
      : await gitDiff(projectDir, [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-color",
          "--",
          "/dev/null",
          safe.path,
        ]);

  return {
    path: safe.path,
    patch: patch.slice(0, MAX_DIFF_CHARS),
    truncated: patch.length > MAX_DIFF_CHARS || undefined,
  };
}

/** Switch a clean repository to `branch`, creating the local branch from its
 * origin counterpart when needed. The clean-tree check is repeated here so a
 * change created after the status read can never be overwritten by the switch. */
export async function resetGitToBranch(projectDir: string, branch: string): Promise<void> {
  if (!hasGitRepo(projectDir)) throw new Error("Project is not a Git repository");
  await git(projectDir, ["check-ref-format", "--branch", branch]);

  const porcelain = (await tryGit(projectDir, STATUS_PORCELAIN_ARGS)) ?? "";
  if (porcelain.length > 0) {
    throw new Error("Commit or restore local changes before resetting the branch");
  }

  const current = (
    (await tryGit(projectDir, ["symbolic-ref", "--quiet", "--short", "HEAD"])) ?? ""
  ).trim();
  if (current === branch) return;

  const hasLocal =
    (await tryGit(projectDir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) !==
    null;
  if (hasLocal) {
    await git(projectDir, ["checkout", branch]);
    return;
  }

  const hasRemote =
    (await tryGit(projectDir, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${branch}`,
    ])) !== null;
  if (!hasRemote) throw new Error(`The ${branch} branch is not available locally`);
  await git(projectDir, ["checkout", "-b", branch, "--track", `origin/${branch}`]);
}

function countChanges(porcelainZ: string): { added: number; modified: number; removed: number } {
  const changes = { added: 0, modified: 0, removed: 0 };
  for (const file of parseChanges(porcelainZ)) {
    changes[file.change] += 1;
  }
  return changes;
}

function deriveState(args: {
  changes: { added: number; modified: number; removed: number };
  ahead: number;
  behind: number;
}): SyncStatus["state"] {
  const dirty = args.changes.added + args.changes.modified + args.changes.removed > 0;
  if (args.ahead > 0 && args.behind > 0) return "diverged";
  if (args.behind > 0) return "behind";
  if (args.ahead > 0 || dirty) return "ahead";
  return "linked";
}

async function ensureInit(dir: string, branch: string): Promise<void> {
  if (!hasGitRepo(dir)) {
    await git(dir, ["init"]);
  }
  // Make sure HEAD is on `branch`. A pre-existing `.git` may sit on a different
  // branch — an older git default (`master`), a leftover from a prior attempt,
  // or a detached HEAD — and without this the later `push … <branch>` fails with
  // "src refspec <branch> does not match any". Guarding on `hasGitRepo` alone
  // isn't enough: a freshly-created `.git` adopts the machine's
  // `init.defaultBranch`, which may not be `branch`. `checkout -B` is safe
  // whether HEAD is unborn (renames the unborn branch), committed (moves/creates
  // the branch at the current commit, leaving the working tree untouched), or
  // detached. No-op when HEAD is already on `branch`.
  const current = (
    (await tryGit(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])) ?? ""
  ).trim();
  if (current !== branch) {
    await git(dir, ["checkout", "-B", branch]);
  }
}

async function ensureRemote(dir: string, url: string): Promise<void> {
  if ((await tryGit(dir, ["remote", "get-url", "origin"])) === null) {
    await git(dir, ["remote", "add", "origin", url]);
  } else {
    await git(dir, ["remote", "set-url", "origin", url]);
  }
}

async function hasCommits(dir: string): Promise<boolean> {
  return (await tryGit(dir, ["rev-parse", "--verify", "HEAD"])) !== null;
}

async function commitAll(
  dir: string,
  message: string,
  opts: { allowEmpty?: boolean } = {},
): Promise<void> {
  await git(dir, ["add", "-A"]);
  const dirty = ((await tryGit(dir, STATUS_PORCELAIN_ARGS)) ?? "").length > 0;
  if (dirty || opts.allowEmpty || !(await hasCommits(dir))) {
    // Identity comes from the repo's local config, written by ensureIdentity()
    // from the connected GitHub account — no hardcoded committer here.
    const args = ["commit", "-m", message];
    if (opts.allowEmpty || !dirty) args.push("--allow-empty");
    await git(dir, args);
  }
}

/** Init + fetch remote branch + force the working tree to match it. Used for
 * the empty-local and pull-remote cases. */
async function fetchCheckout(dir: string, url: string, branch: string): Promise<void> {
  await ensureInit(dir, branch);
  await ensureRemote(dir, url);
  await git(dir, ["fetch", "origin", branch], { timeoutMs: NETWORK_GIT_TIMEOUT_MS });
  await git(dir, ["checkout", "-f", "-B", branch, `origin/${branch}`]);
  await tryGit(dir, ["branch", `--set-upstream-to=origin/${branch}`, branch]);
}

/** Read the GitHub grant's non-secret profile from the connection ledger — the
 * conferral outcome (login/display name/email) recorded alongside the credential.
 * Null when no GitHub connection exists or the grant carries no profile. A
 * degraded grant keeps the profile of the conferral that degraded, so the last
 * known identity survives. */
async function readGithubGrantProfile(db: DrizzleDb): Promise<GithubGrantProfile | null> {
  const ledger = new DrizzleGrantLedger(db);
  const github = (await ledger.listConnections()).filter((c) => c.service === "github");
  // GitHub is a single-slot provider connection; more than one is a corrupt
  // ledger state that would make "the connected identity" ambiguous. Fail loud
  // rather than silently attributing commits to whichever row sorts first.
  if (github.length > 1) {
    throw new Error(`expected at most one GitHub connection, found ${github.length}`);
  }
  const connection = github[0];
  if (!connection) return null;
  const grant = await ledger.getGrant(connection.id, OAUTH_PROVIDER_GRANTS.github);
  // Re-run GitHub's own parse on the stored record — a record that no longer
  // matches the schema fails loudly here, never a silently wrong committer.
  return grant?.profile ? githubGrantProfileSchema.parse(grant.profile) : null;
}

/** The git committer identity for GitHub commits, derived from the connected
 * grant's profile with a generic fallback for every missing field: name is
 * login → display name → "Rome"; email is email → login-based noreply →
 * "rome@localhost". */
export async function githubCommitterIdentity(
  db: DrizzleDb,
): Promise<{ name: string; email: string }> {
  const profile = await readGithubGrantProfile(db);
  const name = profile?.login || profile?.displayName || "Rome";
  const email =
    profile?.email ||
    (profile?.login ? `${profile.login}@users.noreply.github.com` : "rome@localhost");
  return { name, email };
}

export class GitSyncSource implements SyncSource {
  /** Static descriptor so the registry can read id/label/icon/authProvider
   * without instantiating the source (which needs a real `db`). */
  static readonly descriptor: SyncSourceDescriptor = {
    id: "git",
    label: "GitHub",
    icon: "github",
    authProvider: "github",
  };

  readonly id = GitSyncSource.descriptor.id;
  readonly label = GitSyncSource.descriptor.label;
  readonly icon = GitSyncSource.descriptor.icon;
  readonly authProvider = GitSyncSource.descriptor.authProvider;

  constructor(private readonly db: DrizzleDb) {}

  private getToken(): Promise<string | null> {
    return readGithubAccessTokenFile();
  }

  private getCommitterIdentity(): Promise<{ name: string; email: string }> {
    return githubCommitterIdentity(this.db);
  }

  /** Write the GitHub user's identity into the repo's local git config so commits
   * — both ours and the file-save path's plain `git commit` — are attributed to
   * the real user. No-op once configured, so existing repos self-heal cheaply. */
  private async ensureIdentity(dir: string): Promise<void> {
    if (!hasGitRepo(dir)) return;
    if (((await tryGit(dir, ["config", "user.email"])) ?? "").trim()) return;
    const id = await this.getCommitterIdentity();
    await git(dir, ["config", "user.name", id.name]);
    await git(dir, ["config", "user.email", id.email]);
  }

  private async githubFetch(path: string, init?: RequestInit): Promise<unknown> {
    const token = await this.getToken();
    if (!token) throw new Error("GitHub is not connected");
    const res = await fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "rome",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let message = `GitHub API error (${res.status})`;
      try {
        const parsed = JSON.parse(body) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        /* keep default */
      }
      throw new Error(message);
    }
    return res.json();
  }

  async availability(): Promise<SyncAvailability> {
    const token = await this.getToken();
    return token
      ? { available: true }
      : { available: false, reason: "GitHub account is not connected" };
  }

  /** The authenticated user's login. */
  private async getLogin(): Promise<string> {
    const me = (await this.githubFetch("/user")) as { login: string };
    return me.login;
  }

  async listGroups(): Promise<SyncGroup[]> {
    const [me, orgs] = (await Promise.all([
      this.githubFetch("/user"),
      this.githubFetch("/user/orgs?per_page=100"),
    ])) as [{ login: string; avatar_url?: string }, Array<{ login: string; avatar_url?: string }>];
    return [
      { id: me.login, label: me.login, icon: me.avatar_url },
      ...orgs.map((org) => ({ id: org.login, label: org.login, icon: org.avatar_url })),
    ];
  }

  async listTargets(query?: string): Promise<RemoteTargetCandidate[]> {
    const repos = (await this.githubFetch(
      "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
    )) as Array<{
      full_name: string;
      name: string;
      owner: { login: string };
      clone_url: string;
      default_branch: string;
      description: string | null;
      size: number;
      private: boolean;
    }>;
    const q = query?.trim().toLowerCase();
    return repos
      .filter((repo) => !q || repo.full_name.toLowerCase().includes(q))
      .map((repo) => ({
        sourceId: this.id,
        locator: {
          url: repo.clone_url,
          defaultBranch: repo.default_branch || "main",
          private: repo.private,
        },
        label: repo.full_name,
        group: repo.owner?.login,
        description: repo.description ?? undefined,
        isEmpty: repo.size === 0,
      }));
  }

  async createTarget(spec: {
    name: string;
    group?: string;
    private?: boolean;
    description?: string;
  }): Promise<RemoteTarget> {
    // Accept either a bare name or an "owner/name" form; an explicit group wins.
    let group = spec.group?.trim();
    let name = spec.name.trim();
    if (name.includes("/")) {
      const [owner, ...rest] = name.split("/");
      name = rest.join("/");
      group = group || owner;
    }
    if (!name) throw new Error("A repository name is required");

    // Repos owned by the authenticated user go to /user/repos; anything under a
    // different login is an org → /orgs/{org}/repos. Using /user/repos
    // unconditionally would silently create the repo under the user's own
    // scope instead (e.g. "zoolsher/test-2" landing as "zoolsher/zoolsher-test-2").
    const login = await this.getLogin();
    const path = !group || group === login ? "/user/repos" : `/orgs/${group}/repos`;

    const repo = (await this.githubFetch(path, {
      method: "POST",
      body: JSON.stringify({
        name,
        private: spec.private ?? true,
        description: spec.description,
        auto_init: false,
      }),
    })) as { full_name: string; clone_url: string; default_branch: string; private: boolean };
    return {
      sourceId: this.id,
      locator: {
        url: repo.clone_url,
        defaultBranch: repo.default_branch || "main",
        private: repo.private,
      },
      label: repo.full_name,
    };
  }

  async link(
    projectDir: string,
    target: RemoteTarget,
    strategy: LinkStrategy,
  ): Promise<LinkOutcome> {
    const { url, defaultBranch, private: isPrivate } = readTargetIdentity(target);
    // Guard for a friendly error; git network ops authenticate via the gh
    // credential helper, not this token.
    if (!(await this.getToken())) throw new Error("GitHub is not connected");
    mkdirSync(projectDir, { recursive: true });

    const local = localHasContent(projectDir);
    const remote = await remoteHasContent(projectDir, url);

    let resolvedCase: LinkOutcome["resolvedCase"];
    if (!local && !remote) {
      // empty-empty: stand up the link with an empty initial commit.
      await ensureInit(projectDir, defaultBranch);
      await ensureRemote(projectDir, url);
      await this.ensureIdentity(projectDir);
      await commitAll(projectDir, "Initial commit", { allowEmpty: true });
      await git(projectDir, ["push", "-u", "origin", defaultBranch], {
        timeoutMs: NETWORK_GIT_TIMEOUT_MS,
      });
      resolvedCase = "empty-empty";
    } else if (!local && remote) {
      // empty-remote: take the remote.
      await fetchCheckout(projectDir, url, defaultBranch);
      resolvedCase = "empty-remote";
    } else if (local && !remote) {
      // local-empty: push local up.
      await ensureInit(projectDir, defaultBranch);
      await ensureRemote(projectDir, url);
      await this.ensureIdentity(projectDir);
      await commitAll(projectDir, "Initial commit");
      await git(projectDir, ["push", "-u", "origin", defaultBranch], {
        timeoutMs: NETWORK_GIT_TIMEOUT_MS,
      });
      resolvedCase = "local-empty";
    } else {
      // local-remote: conflict — never auto, caller must choose a strategy.
      if (strategy === "auto") {
        throw new Error(
          "Both this folder and the remote already have content. Choose to keep the remote, keep this folder, or merge.",
        );
      }
      await this.resolveConflict(projectDir, url, defaultBranch, strategy);
      resolvedCase = "local-remote";
    }

    const extra: GitLinkExtra = {
      url,
      defaultBranch,
      initialStrategy: strategy,
      private: isPrivate,
      lastSyncedAt: new Date().toISOString(),
    };
    return { status: await this.status(projectDir, extra), extra, resolvedCase };
  }

  private async resolveConflict(
    dir: string,
    url: string,
    branch: string,
    strategy: LinkStrategy,
  ): Promise<void> {
    if (strategy === "push-local") {
      await ensureInit(dir, branch);
      await ensureRemote(dir, url);
      await this.ensureIdentity(dir);
      await commitAll(dir, "Initial commit");
      await git(dir, ["push", "--force", "-u", "origin", branch], {
        timeoutMs: NETWORK_GIT_TIMEOUT_MS,
      });
      return;
    }

    if (strategy === "pull-remote") {
      // Keep the remote: the user explicitly chose to discard local contents, so
      // delete them (including any old .git) and take the remote wholesale. We do
      // NOT keep a backup dir — an untracked backup would get staged by the next
      // `git add -A` and pushed, leaking the very files the user asked to drop.
      for (const entry of readdirSync(dir)) {
        rmSync(join(dir, entry), { recursive: true, force: true });
      }
      await fetchCheckout(dir, url, branch);
      return;
    }

    // merge: attempt to combine unrelated histories.
    await ensureInit(dir, branch);
    await ensureRemote(dir, url);
    await this.ensureIdentity(dir);
    await commitAll(dir, "Local changes before merge");
    await git(dir, ["fetch", "origin", branch], { timeoutMs: NETWORK_GIT_TIMEOUT_MS });
    try {
      await git(dir, ["merge", "--allow-unrelated-histories", `origin/${branch}`]);
      await tryGit(dir, ["branch", `--set-upstream-to=origin/${branch}`, branch]);
    } catch {
      // Merge conflicts are left in the working tree for the user to resolve;
      // status() will report `conflict`.
      await tryGit(dir, ["branch", `--set-upstream-to=origin/${branch}`, branch]);
    }
  }

  async unlink(_projectDir: string): Promise<void> {
    // The binding lives in the DB row; the working tree's `.git` is left intact
    // so the user keeps their local history. Nothing to do at the source level.
  }

  async status(projectDir: string, extra: LinkExtra): Promise<SyncStatus> {
    const ext = decodeGitExtra(extra);
    // Operational truth comes from `.git`; `extra` only supplies things `.git`
    // has no SSOT for (visibility, last Rome sync).
    const fromExtra = {
      defaultRef: ext.defaultBranch,
      private: ext.private,
      lastSyncedAt: ext.lastSyncedAt,
    };

    if (!hasGitRepo(projectDir)) return { state: "unlinked", ...fromExtra };

    // Self-heal: backfill the committer identity for repos linked before this
    // was wired (so a project already connected gets the right git identity on
    // the next status read, e.g. when the dashboard mounts).
    await this.ensureIdentity(projectDir);

    // An in-progress / unresolved merge surfaces as a conflict.
    if (existsSync(join(projectDir, ".git", "MERGE_HEAD"))) {
      const unmerged = (
        (await tryGit(projectDir, ["diff", "--name-only", "--diff-filter=U"])) ?? ""
      ).trim();
      if (unmerged)
        return { state: "conflict", message: "Unresolved merge conflicts", ...fromExtra };
    }

    const ref =
      ((await tryGit(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "").trim() || undefined;
    const remoteUrl = ((await tryGit(projectDir, ["remote", "get-url", "origin"])) ?? "").trim();
    const githubRepo = remoteUrl ? repoFullNameFromUrl(remoteUrl) : null;
    const remoteLabel = githubRepo ?? (remoteUrl ? labelFromUrl(remoteUrl) : undefined);
    const remoteWebUrl = githubRepo ? `https://github.com/${githubRepo}` : undefined;
    const changes = countChanges((await tryGit(projectDir, STATUS_PORCELAIN_ARGS)) ?? "");

    // ahead/behind from the last known upstream — no network here:
    // status reads disk; sync/pull is what refreshes the remote ref.
    let ahead = 0;
    let behind = 0;
    const counts = await tryGit(projectDir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    if (counts) {
      const [b, a] = counts
        .trim()
        .split(/\s+/)
        .map((n) => Number(n) || 0);
      behind = b ?? 0;
      ahead = a ?? 0;
    }

    return {
      state: deriveState({ changes, ahead, behind }),
      ref,
      remoteLabel,
      remoteUrl: remoteWebUrl,
      changes,
      ahead,
      behind,
      ...fromExtra,
    };
  }

  /** The individual files behind `status().changes`, read straight off the
   * working tree. Read-only: no fetch, no commit. Sorted by change kind
   * (added → modified → removed) then path for a stable, scannable list. */
  async listChanges(projectDir: string, _extra: LinkExtra): Promise<ChangedFile[]> {
    if (!hasGitRepo(projectDir)) return [];
    const porcelain = (await tryGit(projectDir, STATUS_PORCELAIN_ARGS)) ?? "";
    const rank: Record<ChangedFile["change"], number> = { added: 0, modified: 1, removed: 2 };
    return parseChanges(porcelain).sort(
      (a, b) => rank[a.change] - rank[b.change] || a.path.localeCompare(b.path),
    );
  }

  async restoreChange(projectDir: string, path: string, _extra: LinkExtra): Promise<void> {
    await restoreGitChange(projectDir, path);
  }

  async restoreAllChanges(projectDir: string, _extra: LinkExtra): Promise<void> {
    await restoreAllGitChanges(projectDir);
  }

  async getChangeDiff(projectDir: string, path: string, _extra: LinkExtra): Promise<ChangeDiff> {
    return getGitChangeDiff(projectDir, path);
  }

  async resetToDefault(projectDir: string, extra: LinkExtra): Promise<SyncStatus> {
    await resetGitToBranch(projectDir, decodeGitExtra(extra).defaultBranch);
    return this.status(projectDir, extra);
  }

  async sync(
    projectDir: string,
    direction: "push" | "pull" | "both",
    extra: LinkExtra,
  ): Promise<SyncOutcome> {
    // Guard for a friendly error; git network ops authenticate via the gh
    // credential helper, not this token.
    if (!(await this.getToken())) throw new Error("GitHub is not connected");
    const ext = decodeGitExtra(extra);

    if (direction === "pull" || direction === "both") {
      await git(projectDir, ["fetch", "origin"], { timeoutMs: NETWORK_GIT_TIMEOUT_MS });
      try {
        await git(projectDir, ["merge", "--ff-only", "@{u}"]);
      } catch {
        log.warn("ff-only pull failed; leaving working tree for manual resolution");
      }
    }

    if (direction === "push" || direction === "both") {
      await this.ensureIdentity(projectDir);
      await commitAll(projectDir, "Sync from Rome");
      await git(projectDir, ["push"], { timeoutMs: NETWORK_GIT_TIMEOUT_MS });
    }

    // A sync is the natural moment to refresh the remote's current visibility
    // (it may have been flipped on GitHub since link time). One extra API call
    // per pull/push — not per status read.
    const refreshedPrivate = await this.fetchRemotePrivate(projectDir);
    const nextExtra: GitLinkExtra = {
      url: ext.url,
      defaultBranch: ext.defaultBranch,
      initialStrategy: ext.initialStrategy,
      private: refreshedPrivate ?? ext.private,
      lastSyncedAt: new Date().toISOString(),
    };
    return { status: await this.status(projectDir, nextExtra), extra: nextExtra };
  }

  /** Current visibility of the linked remote, fetched from GitHub. Returns
   * undefined if it can't be determined (no remote, network/API failure). */
  private async fetchRemotePrivate(dir: string): Promise<boolean | undefined> {
    const url = ((await tryGit(dir, ["remote", "get-url", "origin"])) ?? "").trim();
    const fullName = url ? repoFullNameFromUrl(url) : null;
    if (!fullName) return undefined;
    try {
      const repo = (await this.githubFetch(`/repos/${fullName}`)) as { private?: boolean };
      return typeof repo.private === "boolean" ? repo.private : undefined;
    } catch {
      return undefined;
    }
  }
}
