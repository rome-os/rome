import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { LintEnvironmentError, lintAgentsSymlinks, runCli } from "./check-agents-symlinks.js";

const execFileAsync = promisify(execFile);

let repo: string;

function lint(): string[] {
  return lintAgentsSymlinks(repo).findings;
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo });
  return stdout;
}

async function writeClaudeMd(dir: string): Promise<void> {
  await mkdir(path.join(repo, dir), { recursive: true });
  await writeFile(path.join(repo, dir, "CLAUDE.md"), "# guidance\n");
}

/** Writes a blob with exactly these bytes and stages it as a symlink at `at`. */
async function stageSymlinkBlob(at: string, target: string, stage = 0): Promise<void> {
  await writeFile(path.join(repo, "blob-source"), target);
  const sha = (await git("hash-object", "-w", "--no-filters", "blob-source")).trim();
  await rm(path.join(repo, "blob-source"));
  if (stage === 0) {
    await git("update-index", "--add", "--cacheinfo", `120000,${sha},${at}`);
    return;
  }
  await writeFile(path.join(repo, "stages"), `120000 ${sha} ${stage}\t${at}\n`);
  await execFileAsync("sh", ["-c", "git update-index --index-info < stages"], { cwd: repo });
  await rm(path.join(repo, "stages"));
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "agents-symlink-lint-"));
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("lintAgentsSymlinks", () => {
  it("passes when every CLAUDE.md has a committed AGENTS.md symlink", async () => {
    await writeClaudeMd(".");
    await writeClaudeMd("packages/web");
    await symlink("CLAUDE.md", path.join(repo, "AGENTS.md"));
    await symlink("CLAUDE.md", path.join(repo, "packages/web/AGENTS.md"));
    await git("add", "-A");

    expect(lintAgentsSymlinks(repo)).toEqual({ checked: 2, findings: [] });
  });

  it("reports a nested CLAUDE.md with no AGENTS.md", async () => {
    await writeClaudeMd(".");
    await symlink("CLAUDE.md", path.join(repo, "AGENTS.md"));
    await writeClaudeMd("docs");
    await git("add", "-A");

    expect(lint()).toEqual([
      "docs/AGENTS.md is missing — create it with: ln -s -- CLAUDE.md docs/AGENTS.md && " +
        "git --literal-pathspecs add -- docs/AGENTS.md",
    ]);
  });

  it("reports a conflicted AGENTS.md instead of linting one merge stage", async () => {
    await writeClaudeMd(".");
    await git("add", "CLAUDE.md");
    const sha = (await git("rev-parse", ":CLAUDE.md")).trim();
    const stages = [1, 2, 3].map((stage) => `120000 ${sha} ${stage}\tAGENTS.md`).join("\n");
    await writeFile(path.join(repo, "stages"), `${stages}\n`);
    await execFileAsync("sh", ["-c", "git update-index --index-info < stages"], { cwd: repo });
    await rm(path.join(repo, "stages"));

    expect(lint()).toEqual([
      "AGENTS.md has unresolved merge stages — resolve the conflict, then re-run",
    ]);
  });

  it("reports a single-stage unmerged AGENTS.md", async () => {
    await writeClaudeMd(".");
    await git("add", "CLAUDE.md");
    // An unmerged path may carry one stage rather than all three.
    await stageSymlinkBlob("AGENTS.md", "CLAUDE.md", 2);

    expect(lint()).toEqual([
      "AGENTS.md has unresolved merge stages — resolve the conflict, then re-run",
    ]);
  });

  it("reports an AGENTS.md committed as a regular file copy", async () => {
    await writeClaudeMd(".");
    await writeFile(path.join(repo, "AGENTS.md"), "# guidance\n");
    await git("add", "-A");

    expect(lint()[0]).toContain("AGENTS.md is committed as a regular file (mode 100644)");
  });

  it("reports an untracked AGENTS.md that is a plain file", async () => {
    await writeClaudeMd(".");
    await git("add", "CLAUDE.md");
    await writeFile(path.join(repo, "AGENTS.md"), "# guidance\n");

    expect(lint()).toEqual([
      "AGENTS.md exists but is not a symlink — replace it with: " +
        "ln -sf -- CLAUDE.md AGENTS.md && git --literal-pathspecs add -- AGENTS.md",
    ]);
  });

  it("does not accept a child of an AGENTS.md directory as the link", async () => {
    await writeClaudeMd(".");
    await mkdir(path.join(repo, "AGENTS.md"));
    // A pathspec naming a directory matches everything under it, so this child
    // would answer the index lookup for AGENTS.md itself.
    await symlink("CLAUDE.md", path.join(repo, "AGENTS.md/only-child"));
    await git("add", "-A");

    expect(lint()[0]).toContain("AGENTS.md is a directory — remove or rename it");
  });

  it("converges after the directory remediation is followed", async () => {
    await writeClaudeMd(".");
    await mkdir(path.join(repo, "AGENTS.md"));
    await symlink("CLAUDE.md", path.join(repo, "AGENTS.md/only-child"));
    await git("add", "-A");

    // `ln -sf` would land inside the directory, so the advice says to remove it
    // first; following both steps must leave a clean tree.
    const fix = lint()[0].split("remove or rename it, then: ")[1];
    await rm(path.join(repo, "AGENTS.md"), { recursive: true });
    await execFileAsync("sh", ["-c", fix], { cwd: repo });

    expect(lint()).toEqual([]);
  });

  it("skips the children of a directory named CLAUDE.md", async () => {
    await writeClaudeMd(".");
    await symlink("CLAUDE.md", path.join(repo, "AGENTS.md"));
    await mkdir(path.join(repo, "docs/CLAUDE.md"), { recursive: true });
    await writeFile(path.join(repo, "docs/CLAUDE.md/notes"), "not guidance\n");
    await git("add", "-A");

    expect(lintAgentsSymlinks(repo)).toEqual({ checked: 1, findings: [] });
  });

  it("reports a leading-colon directory instead of failing check-ignore", async () => {
    await writeClaudeMd(".");
    await symlink("CLAUDE.md", path.join(repo, "AGENTS.md"));
    // git reads a leading colon as pathspec magic, which check-ignore rejects.
    await writeClaudeMd(":(glob)");
    await git("add", "-A");

    expect(lint()[0]).toContain(":(glob)/AGENTS.md is missing");
  });

  it("reports a symlink pointing at a different CLAUDE.md", async () => {
    await writeClaudeMd(".");
    await writeClaudeMd("docs");
    await symlink("CLAUDE.md", path.join(repo, "AGENTS.md"));
    await symlink("../CLAUDE.md", path.join(repo, "docs/AGENTS.md"));
    await git("add", "-A");

    expect(lint()).toEqual([
      'docs/AGENTS.md is a symlink to "../CLAUDE.md" — it must point at the CLAUDE.md beside it',
    ]);
  });

  it("reports a committed link target with a trailing newline", async () => {
    await writeClaudeMd(".");
    await git("add", "CLAUDE.md");
    // This blob checks out as a link to a file that does not exist.
    await stageSymlinkBlob("AGENTS.md", "CLAUDE.md\n");

    expect(lint()[0]).toContain('AGENTS.md is a symlink to "CLAUDE.md\\n"');
  });

  it("reports an on-disk link target with a trailing newline", async () => {
    await writeClaudeMd(".");
    await symlink("CLAUDE.md\n", path.join(repo, "AGENTS.md"));

    expect(lint()[0]).toContain('AGENTS.md is a symlink to "CLAUDE.md\\n"');
  });

  it("reports a committed link target with an embedded NUL", async () => {
    await writeClaudeMd(".");
    await git("add", "CLAUDE.md");
    await stageSymlinkBlob("AGENTS.md", "CLAUDE.md\0");

    expect(lint()[0]).toContain("AGENTS.md is a symlink to");
  });

  it("does not let a glob metacharacter in a path match another directory", async () => {
    await writeClaudeMd("docs/starXdir");
    await symlink("CLAUDE.md", path.join(repo, "docs/starXdir/AGENTS.md"));
    await writeClaudeMd("docs/star*dir");
    await git("add", "-A");

    // As a pathspec, `docs/star*dir/AGENTS.md` would match the sibling's link.
    expect(lint()[0]).toContain("docs/star*dir/AGENTS.md is missing");
  });

  it("keeps the suggested git command from globbing onto a sibling", async () => {
    await writeClaudeMd("docs/starXdir");
    await symlink("CLAUDE.md", path.join(repo, "docs/starXdir/AGENTS.md"));
    await writeClaudeMd("docs/star*dir");
    await git("add", "-A");

    // Plain `git add -- 'docs/star*dir/AGENTS.md'` would stage the sibling too.
    expect(lint()[0]).toContain("git --literal-pathspecs add -- 'docs/star*dir/AGENTS.md'");
  });

  it("names the real path, and quotes it in the fix, for an awkward directory name", async () => {
    await writeClaudeMd("docs/ünïcode dir");

    // git C-quotes this path in its default output, and the suggested command
    // would split on the space.
    expect(lint()).toEqual([
      "docs/ünïcode dir/AGENTS.md is missing — create it with: " +
        "ln -s -- CLAUDE.md 'docs/ünïcode dir/AGENTS.md' && " +
        "git --literal-pathspecs add -- 'docs/ünïcode dir/AGENTS.md'",
    ]);
  });

  it("reports a symlink that exists on disk but was never added to git", async () => {
    await writeClaudeMd(".");
    await git("add", "CLAUDE.md");
    await symlink("CLAUDE.md", path.join(repo, "AGENTS.md"));

    expect(lint()[0]).toContain("AGENTS.md is not tracked by git");
  });

  it("advises un-ignoring when the missing AGENTS.md path is gitignored", async () => {
    await writeClaudeMd(".");
    await writeFile(path.join(repo, ".gitignore"), "AGENTS.md\n");
    await git("add", "CLAUDE.md", ".gitignore");

    // Creating the link would not help: staging it is what the ignore blocks.
    expect(lint()).toEqual([
      "AGENTS.md is matched by a gitignore rule, so the symlink cannot be tracked — un-ignore the path, then re-run",
    ]);
  });

  it("advises un-ignoring, not git add, when the unstaged symlink is gitignored", async () => {
    await writeClaudeMd(".");
    await writeFile(path.join(repo, ".gitignore"), "AGENTS.md\n");
    await git("add", "CLAUDE.md", ".gitignore");
    await symlink("CLAUDE.md", path.join(repo, "AGENTS.md"));

    // `git add` would refuse the path without -f, so it must not be the advice.
    expect(lint()).toEqual([
      "AGENTS.md is matched by a gitignore rule, so the symlink cannot be tracked — un-ignore the path, then re-run",
    ]);
  });

  it("advises un-ignoring even while the CLAUDE.md is itself untracked", async () => {
    await writeFile(path.join(repo, ".gitignore"), "AGENTS.md\n");
    await writeClaudeMd(".");
    await symlink("CLAUDE.md", path.join(repo, "AGENTS.md"));

    // The link looks right, but it can never follow CLAUDE.md into a commit.
    expect(lint()).toEqual([
      "AGENTS.md is matched by a gitignore rule, so the symlink cannot be tracked — un-ignore the path, then re-run",
    ]);
  });

  it("passes when both files are still untracked", async () => {
    await writeClaudeMd(".");
    await symlink("CLAUDE.md", path.join(repo, "AGENTS.md"));

    expect(lint()).toEqual([]);
  });

  it("lints an untracked CLAUDE.md before it is committed", async () => {
    await writeClaudeMd("rome_apps");

    expect(lint()[0]).toContain("rome_apps/AGENTS.md is missing");
  });

  it("ignores CLAUDE.md files under gitignored paths", async () => {
    await writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
    await writeClaudeMd("node_modules/some-dep");

    expect(lintAgentsSymlinks(repo)).toEqual({ checked: 0, findings: [] });
  });

  it("throws instead of passing when run outside a git repository", async () => {
    const loose = await mkdtemp(path.join(tmpdir(), "agents-symlink-lint-nogit-"));
    try {
      expect(() => lintAgentsSymlinks(loose)).toThrow(LintEnvironmentError);
    } finally {
      await rm(loose, { recursive: true, force: true });
    }
  });

  // Root ignores directory permissions, so the scenario cannot be built there.
  it.skipIf(process.getuid?.() === 0)(
    "throws instead of passing when a directory cannot be listed",
    async () => {
      await writeClaudeMd(".");
      await symlink("CLAUDE.md", path.join(repo, "AGENTS.md"));
      await git("add", "-A");
      await writeClaudeMd("locked");
      await chmod(path.join(repo, "locked"), 0o000);

      try {
        // git warns and still exits 0, leaving locked/CLAUDE.md unexamined.
        expect(() => lintAgentsSymlinks(repo)).toThrow(LintEnvironmentError);
      } finally {
        await chmod(path.join(repo, "locked"), 0o755);
      }
    },
  );

  it("throws instead of passing when a path cannot be read", async () => {
    await writeClaudeMd("docs");
    await git("add", "-A");
    // The index still holds docs/CLAUDE.md, so the working-tree lookup for
    // docs/AGENTS.md hits ENOTDIR rather than a missing file.
    await rm(path.join(repo, "docs"), { recursive: true });
    await writeFile(path.join(repo, "docs"), "not a directory\n");

    expect(() => lintAgentsSymlinks(repo)).toThrow(LintEnvironmentError);
  });

  it("throws instead of passing when the index cannot be read", async () => {
    await writeClaudeMd(".");
    await symlink("CLAUDE.md", path.join(repo, "AGENTS.md"));
    await git("add", "-A");
    await writeFile(path.join(repo, ".git/index"), "not an index");

    expect(() => lintAgentsSymlinks(repo)).toThrow(LintEnvironmentError);
  });
});

describe("runCli", () => {
  it("exits 0 on a clean repo", async () => {
    await writeClaudeMd(".");
    await symlink("CLAUDE.md", path.join(repo, "AGENTS.md"));
    await git("add", "-A");

    expect(runCli(repo)).toBe(0);
  });

  it("exits 1 on findings", async () => {
    await writeClaudeMd(".");
    await git("add", "-A");

    expect(runCli(repo)).toBe(1);
  });

  it("exits 2 when the repository holds no CLAUDE.md at all", async () => {
    await writeFile(path.join(repo, "README.md"), "# nothing to lint\n");
    await git("add", "-A");

    expect(runCli(repo)).toBe(2);
  });

  it("exits 2 when the check cannot run", async () => {
    const loose = await mkdtemp(path.join(tmpdir(), "agents-symlink-lint-nogit-"));
    try {
      expect(runCli(loose)).toBe(2);
    } finally {
      await rm(loose, { recursive: true, force: true });
    }
  });
});
