import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "@rstest/core";
import {
  OAUTH_PROVIDER_GRANTS,
  type GithubGrantProfile,
} from "../connections/integrations/oauth-providers.js";
import { DrizzleGrantLedger } from "../connections/ledger-db.js";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/helpers.js";
import {
  GitSyncSource,
  getGitChangeDiff,
  githubCommitterIdentity,
  parseChanges,
  resetGitToBranch,
  restoreAllGitChanges,
  restoreGitChange,
} from "./git-source.js";

const tempDirs: string[] = [];
const savedTokenFileEnv = process.env.ROME_GITHUB_TOKEN_FILE;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedTokenFileEnv === undefined) delete process.env.ROME_GITHUB_TOKEN_FILE;
  else process.env.ROME_GITHUB_TOKEN_FILE = savedTokenFileEnv;
});

/** Point the GitHub token file at a fresh temp path; return its location so a
 * test can materialize or omit the custody artifact. */
function useTokenFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "rome-sync-token-"));
  tempDirs.push(dir);
  const path = join(dir, "github-oauth-token");
  process.env.ROME_GITHUB_TOKEN_FILE = path;
  return path;
}

/** Seed a connected GitHub grant carrying `profile` in the ledger. */
async function seedGithubGrant(
  db: ReturnType<typeof createTestDb>["db"],
  profile: GithubGrantProfile | undefined,
  id = "conn-github",
): Promise<void> {
  const ledger = new DrizzleGrantLedger(db);
  await ledger.createConnection({ id, service: "github", label: "github", createdAt: new Date() });
  await ledger.ensureGrant(id, OAUTH_PROVIDER_GRANTS.github);
  await ledger.updateGrant(id, OAUTH_PROVIDER_GRANTS.github, {
    state: "authorized",
    ...(profile ? { profile } : {}),
  });
}

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rome-sync-restore-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Rome Test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "rome@example.com"], { cwd: dir });
  writeFileSync(join(dir, "tracked.txt"), "baseline\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: dir });
  execFileSync("git", ["branch", "-M", "main"], { cwd: dir });
  return dir;
}

describe("parseChanges", () => {
  it("classifies porcelain status codes into added/modified/removed", () => {
    const porcelain = [
      "?? untracked.ts",
      "A  staged-add.ts",
      " M worktree-mod.ts",
      "MM staged-and-worktree.ts",
      " D worktree-del.ts",
      "D  staged-del.ts",
    ].join("\0");

    expect(parseChanges(porcelain)).toEqual([
      { path: "untracked.ts", change: "added" },
      { path: "staged-add.ts", change: "added" },
      { path: "worktree-mod.ts", change: "modified" },
      { path: "staged-and-worktree.ts", change: "modified" },
      { path: "worktree-del.ts", change: "removed" },
      { path: "staged-del.ts", change: "removed" },
    ]);
  });

  it("reports the destination path for renames", () => {
    expect(parseChanges("R  src/new-name.ts\0src/old-name.ts\0")).toEqual([
      { path: "src/new-name.ts", change: "modified" },
    ]);
  });

  it("keeps paths with spaces and literal arrows intact", () => {
    expect(parseChanges("?? my notes -> draft.md\0")).toEqual([
      { path: "my notes -> draft.md", change: "added" },
    ]);
  });

  it("keeps unicode paths intact", () => {
    expect(parseChanges("?? 你好.txt\0")).toEqual([{ path: "你好.txt", change: "added" }]);
  });

  it("does not treat arrows in a rename source path as separators", () => {
    expect(parseChanges("R  after.ts\0before -> source.ts\0")).toEqual([
      { path: "after.ts", change: "modified" },
    ]);
  });

  it("ignores blank lines and an empty tree", () => {
    expect(parseChanges("")).toEqual([]);
    expect(parseChanges("\0")).toEqual([]);
  });
});

describe("GitSyncSource.status", () => {
  it("omits the redundant GitHub host from the remote label", async () => {
    const source = new GitSyncSource(null as never);

    for (const remoteUrl of [
      "https://github.com/amantru/rome-internal.git",
      "git@github.com:amantru/rome-internal.git",
    ]) {
      const dir = createRepo();
      execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });

      await expect(source.status(dir, {})).resolves.toMatchObject({
        remoteLabel: "amantru/rome-internal",
        remoteUrl: "https://github.com/amantru/rome-internal",
      });
    }
  });

  it("keeps the host for non-GitHub remotes", async () => {
    const dir = createRepo();
    const source = new GitSyncSource(null as never);
    execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/acme/project.git"], {
      cwd: dir,
    });

    const status = await source.status(dir, {});
    expect(status).toMatchObject({ remoteLabel: "gitlab.com/acme/project" });
    expect(status.remoteUrl).toBeUndefined();
  });
});

describe("restoreGitChange", () => {
  it("restores modified and deleted tracked files", async () => {
    const dir = createRepo();
    writeFileSync(join(dir, "tracked.txt"), "changed\n");

    await restoreGitChange(dir, "tracked.txt");
    expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe("baseline\n");

    rmSync(join(dir, "tracked.txt"));
    await restoreGitChange(dir, "tracked.txt");
    expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe("baseline\n");
  });

  it("removes untracked files and prunes their empty parent directories", async () => {
    const dir = createRepo();
    writeFileSync(join(dir, "untracked.txt"), "local\n");

    await restoreGitChange(dir, "untracked.txt");
    expect(existsSync(join(dir, "untracked.txt"))).toBe(false);

    mkdirSync(join(dir, "untracked"));
    writeFileSync(join(dir, "untracked", "nested.txt"), "local\n");
    await restoreGitChange(dir, "untracked/nested.txt");
    expect(existsSync(join(dir, "untracked"))).toBe(false);
  });

  it("restores both sides of a staged rename", async () => {
    const dir = createRepo();
    execFileSync("git", ["mv", "tracked.txt", "renamed.txt"], { cwd: dir });

    await restoreGitChange(dir, "renamed.txt");

    expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe("baseline\n");
    expect(existsSync(join(dir, "renamed.txt"))).toBe(false);
  });

  it("rejects paths that are not current changes", async () => {
    const dir = createRepo();
    await expect(restoreGitChange(dir, "../outside.txt")).rejects.toThrow(
      "no longer has local changes",
    );
  });
});

describe("restoreAllGitChanges", () => {
  it("restores tracked files and removes every untracked path", async () => {
    const dir = createRepo();
    writeFileSync(join(dir, "tracked.txt"), "changed\n");
    writeFileSync(join(dir, "untracked.txt"), "local\n");
    mkdirSync(join(dir, "untracked-dir"));
    writeFileSync(join(dir, "untracked-dir", "nested.txt"), "local\n");

    await restoreAllGitChanges(dir);

    expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe("baseline\n");
    expect(existsSync(join(dir, "untracked.txt"))).toBe(false);
    expect(existsSync(join(dir, "untracked-dir"))).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString()).toBe("");
  });
});

describe("getGitChangeDiff", () => {
  it("returns the HEAD-to-working-tree patch for a modified file", async () => {
    const dir = createRepo();
    writeFileSync(join(dir, "tracked.txt"), "baseline\nnew line\n");

    const result = await getGitChangeDiff(dir, "tracked.txt");

    expect(result.path).toBe("tracked.txt");
    expect(result.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.patch).toContain("+new line");
    expect(result.truncated).toBeUndefined();
  });

  it("returns an empty-file patch for an untracked file", async () => {
    const dir = createRepo();
    writeFileSync(join(dir, "new file.txt"), "first\nsecond\n");

    const result = await getGitChangeDiff(dir, "new file.txt");

    expect(result.patch).toContain("new file mode");
    expect(result.patch).toContain("+first");
    expect(result.patch).toContain("+second");
  });

  it("diffs each file inside an untracked directory", async () => {
    const dir = createRepo();
    mkdirSync(join(dir, "new-dir"));
    writeFileSync(join(dir, "new-dir", "first.txt"), "first\n");
    writeFileSync(join(dir, "new-dir", "second.txt"), "second\n");

    const source = new GitSyncSource(null as never);
    await expect(source.listChanges(dir, {})).resolves.toEqual([
      { path: "new-dir/first.txt", change: "added" },
      { path: "new-dir/second.txt", change: "added" },
    ]);

    const result = await getGitChangeDiff(dir, "new-dir/first.txt");
    expect(result.path).toBe("new-dir/first.txt");
    expect(result.patch).toContain("+first");
  });

  it("does not expose ignored files inside an untracked directory", async () => {
    const dir = createRepo();
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "ignore logs"], { cwd: dir });
    mkdirSync(join(dir, "new-dir"));
    writeFileSync(join(dir, "new-dir", "shown.txt"), "shown\n");
    writeFileSync(join(dir, "new-dir", "ignored.log"), "ignored\n");

    const source = new GitSyncSource(null as never);
    await expect(source.listChanges(dir, {})).resolves.toEqual([
      { path: "new-dir/shown.txt", change: "added" },
    ]);
    await expect(getGitChangeDiff(dir, "new-dir/ignored.log")).rejects.toThrow(
      "no longer has local changes",
    );
  });

  it("rejects a path that is not a current change", async () => {
    const dir = createRepo();
    await expect(getGitChangeDiff(dir, "../outside.txt")).rejects.toThrow(
      "no longer has local changes",
    );
  });
});

describe("resetGitToBranch", () => {
  it("switches a clean feature branch back to main", async () => {
    const dir = createRepo();
    execFileSync("git", ["checkout", "-qb", "feature"], { cwd: dir });

    await resetGitToBranch(dir, "main");

    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim(),
    ).toBe("main");
  });

  it("refuses to switch when local changes appeared after the status check", async () => {
    const dir = createRepo();
    execFileSync("git", ["checkout", "-qb", "feature"], { cwd: dir });
    writeFileSync(join(dir, "tracked.txt"), "changed after status\n");

    await expect(resetGitToBranch(dir, "main")).rejects.toThrow("Commit or restore local changes");
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim(),
    ).toBe("feature");
    expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe("changed after status\n");
  });

  it("creates the local main branch from origin when only the remote ref exists", async () => {
    const dir = createRepo();
    execFileSync("git", ["remote", "add", "origin", "https://example.com/repo.git"], { cwd: dir });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: dir });
    execFileSync("git", ["checkout", "-qb", "feature"], { cwd: dir });
    execFileSync("git", ["branch", "-D", "main"], { cwd: dir });

    await resetGitToBranch(dir, "main");

    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim(),
    ).toBe("main");
  });
});

describe("GitSyncSource.availability", () => {
  it("is available when the GitHub token file holds a token", async () => {
    const path = useTokenFile();
    writeFileSync(path, "gho_livetoken\n");
    const source = new GitSyncSource(null as never);

    await expect(source.availability()).resolves.toEqual({ available: true });
  });

  it("reports not-connected when the token file is absent", async () => {
    useTokenFile(); // path set, but no file written — grant degraded/disconnected/pre-boot
    const source = new GitSyncSource(null as never);

    await expect(source.availability()).resolves.toEqual({
      available: false,
      reason: "GitHub account is not connected",
    });
  });

  it("reports not-connected when the token file is empty", async () => {
    const path = useTokenFile();
    writeFileSync(path, "\n");
    const source = new GitSyncSource(null as never);

    await expect(source.availability()).resolves.toMatchObject({ available: false });
  });
});

describe("githubCommitterIdentity", () => {
  it("attributes commits to the conferred grant identity", async () => {
    const { db, close } = createTestDb();
    try {
      await seedGithubGrant(db, {
        login: "octocat",
        displayName: "Octo Cat",
        email: "octo@example.com",
      });

      await expect(githubCommitterIdentity(db)).resolves.toEqual({
        name: "octocat",
        email: "octo@example.com",
      });
    } finally {
      close();
    }
  });

  it("derives a noreply email from the login when the profile has no email", async () => {
    const { db, close } = createTestDb();
    try {
      await seedGithubGrant(db, { login: "octocat" });

      await expect(githubCommitterIdentity(db)).resolves.toEqual({
        name: "octocat",
        email: "octocat@users.noreply.github.com",
      });
    } finally {
      close();
    }
  });

  it("falls back to display name and a generic email when there is no login", async () => {
    const { db, close } = createTestDb();
    try {
      await seedGithubGrant(db, { displayName: "Octo Cat" });

      await expect(githubCommitterIdentity(db)).resolves.toEqual({
        name: "Octo Cat",
        email: "rome@localhost",
      });
    } finally {
      close();
    }
  });

  it("falls back to the generic identity when the grant carries no profile", async () => {
    const { db, close } = createTestDb();
    try {
      await seedGithubGrant(db, undefined);

      await expect(githubCommitterIdentity(db)).resolves.toEqual({
        name: "Rome",
        email: "rome@localhost",
      });
    } finally {
      close();
    }
  });

  it("falls back to the generic identity when no GitHub connection exists", async () => {
    const { db, close } = createTestDb();
    try {
      await expect(githubCommitterIdentity(db)).resolves.toEqual({
        name: "Rome",
        email: "rome@localhost",
      });
    } finally {
      close();
    }
  });

  it("rejects when more than one GitHub connection exists", async () => {
    // Model a legacy store before the Service-unique migration. The current
    // schema cannot create this state, but this defensive read must still never
    // silently choose one authority-bearing row if migration was bypassed.
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE connections (
        id text PRIMARY KEY NOT NULL,
        service text NOT NULL,
        label text NOT NULL,
        created_at integer NOT NULL
      );
      CREATE TABLE connection_grants (
        custody text NOT NULL,
        name text NOT NULL,
        state text NOT NULL,
        credential text,
        profile text,
        conferred_at integer,
        last_renewed_at integer,
        degraded_at integer,
        degraded_reason text,
        PRIMARY KEY (custody, name)
      );
    `);
    const db = drizzle(sqlite) as unknown as DrizzleDb;
    try {
      await seedGithubGrant(db, { login: "octocat" }, "conn-github-1");
      await seedGithubGrant(db, { login: "hubot" }, "conn-github-2");

      await expect(githubCommitterIdentity(db)).rejects.toThrow(
        "expected at most one GitHub connection, found 2",
      );
    } finally {
      sqlite.close();
    }
  });
});
