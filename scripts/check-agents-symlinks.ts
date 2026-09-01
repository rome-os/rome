#!/usr/bin/env tsx
/**
 * Make sure every CLAUDE.md has an AGENTS.md symlink beside it.
 *
 * Claude Code reads CLAUDE.md, other coding agents read AGENTS.md, and only a
 * symlink makes the two unable to drift — so a copy is a finding, not a pass.
 *
 * Tracked links are judged by the index (a mode-120000 blob whose content is the
 * target), which keeps the verdict identical on platforms that check symlinks out
 * as plain files. Untracked ones are judged on disk, so a new CLAUDE.md fails
 * before it is committed rather than on the PR that adds it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LINK_TARGET = "CLAUDE.md";
const SYMLINK_MODE = "120000";
/**
 * The git prefix every suggested command carries: `--` ends option parsing but
 * not pathspec magic, so `git add -- 'star*dir/AGENTS.md'` would also stage a
 * sibling `starXdir/AGENTS.md`.
 */
const GIT = "git --literal-pathspecs";

/** The invariant could not be evaluated. Never reported as a pass. */
export class LintEnvironmentError extends Error {}

export type LintResult = {
  /** How many CLAUDE.md files were examined. */
  checked: number;
  findings: string[];
};

/** Both streams, because some git commands warn on stderr and still exit 0. */
function run(cwd: string, args: string[], input?: string): { stdout: Buffer; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    input: input === undefined ? undefined : Buffer.from(input),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new LintEnvironmentError(`git ${args.join(" ")} failed: ${result.error.message}`);
  }
  const stderr = result.stderr.toString().trim();
  if (result.status !== 0) {
    throw new LintEnvironmentError(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return { stdout: result.stdout, stderr };
}

function git(cwd: string, args: string[], input?: string): Buffer {
  return run(cwd, args, input).stdout;
}

/**
 * Runs git for its exit status. `answers` lists the non-zero codes that mean a
 * verdict rather than a breakdown — anything else is a failure to evaluate, not
 * a "no".
 */
function gitExitCode(cwd: string, args: string[], answers: number[]): number {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return 0;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === undefined || !answers.includes(status)) {
      throw new LintEnvironmentError(`git ${args.join(" ")} failed with status ${status}`);
    }
    return status;
  }
}

function isTracked(root: string, file: string): boolean {
  return gitExitCode(root, literal(["ls-files", "--error-unmatch", "--", file]), [1]) === 0;
}

/**
 * check-ignore takes pathnames, not pathspecs, and rejects pathspec magic — so
 * a path starting with a colon needs `./` in front of it to parse as a name.
 */
function isIgnored(root: string, file: string): boolean {
  return gitExitCode(root, ["check-ignore", "-q", "--", `./${file}`], [1]) === 0;
}

/**
 * git treats `*`, `?` and `[]` in a pathspec as magic, so a directory named
 * `star*dir` would glob its way onto another directory's link.
 */
function literal(args: string[]): string[] {
  return ["--literal-pathspecs", ...args];
}

/** Quotes a path for the shell commands the findings suggest. */
function shellQuote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function splitNul(output: Buffer): string[] {
  return output
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

type IndexEntry = { mode: string; sha: string; stage: string };

function readIndexEntry(root: string, file: string): IndexEntry | null {
  const records = splitNul(git(root, literal(["ls-files", "--stage", "-z", "--", file])));
  // "<mode> <sha> <stage>\t<path>", one record per stage. A pathspec naming a
  // directory also matches everything under it, so a directory named AGENTS.md
  // would answer with a child of itself.
  const first = records.find((record) => record.slice(record.indexOf("\t") + 1) === file);
  if (!first) return null;
  const [meta] = first.split("\t");
  const [mode, sha, stage] = meta.split(" ");
  return { mode, sha, stage };
}

type OnDisk = "absent" | "symlink" | "directory" | "other";

/**
 * `throwIfNoEntry` only covers ENOENT — ENOTDIR, EACCES and the like still
 * throw, and a filesystem that cannot be read is a failure to evaluate the
 * invariant, not a finding about it.
 */
function inspect(absolute: string): { kind: OnDisk; target?: string } {
  try {
    const stats = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stats) return { kind: "absent" };
    if (stats.isSymbolicLink()) return { kind: "symlink", target: readlinkSync(absolute) };
    return { kind: stats.isDirectory() ? "directory" : "other" };
  } catch (error) {
    throw new LintEnvironmentError(`cannot read ${absolute}: ${(error as Error).message}`);
  }
}

/**
 * Reports every CLAUDE.md whose AGENTS.md is missing, is not a symlink, or does
 * not point at the CLAUDE.md beside it. Each finding names the fix for it.
 *
 * Throws LintEnvironmentError when the repository cannot be read at all.
 */
export function lintAgentsSymlinks(cwd: string = process.cwd()): LintResult {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();

  // -z keeps git from C-quoting non-ASCII paths (core.quotePath), which would
  // hand back a quoted rendering in place of the filename.
  const listing = run(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    LINK_TARGET,
    `*/${LINK_TARGET}`,
  ]);
  // ls-files exits 0 after warning that it could not read a directory, so a
  // whole subtree can go unexamined behind a clean verdict.
  if (listing.stderr) {
    throw new LintEnvironmentError(`could not enumerate every ${LINK_TARGET}: ${listing.stderr}`);
  }
  // Untracked-but-not-ignored files are in there too, and a conflicted path is
  // listed once per index stage. The basename filter drops the children of a
  // directory that happens to be named CLAUDE.md, which the pathspec matches.
  const claudeFiles = [...new Set(splitNul(listing.stdout))]
    .filter((file) => path.basename(file) === LINK_TARGET)
    .sort();

  const expectedSha = git(root, ["hash-object", "--stdin"], LINK_TARGET).toString("utf8").trim();

  const findings: string[] = [];
  for (const claude of claudeFiles) {
    const dir = path.dirname(claude);
    const agents = dir === "." ? "AGENTS.md" : `${dir}/AGENTS.md`;
    const quoted = shellQuote(agents);

    const entry = readIndexEntry(root, agents);
    if (entry) {
      // Any stage but 0 is an unmerged entry, and linting one side of a merge
      // answers a question about a tree that does not exist yet.
      if (entry.stage !== "0") {
        findings.push(`${agents} has unresolved merge stages — resolve the conflict, then re-run`);
      } else if (entry.mode !== SYMLINK_MODE) {
        findings.push(
          `${agents} is committed as a regular file (mode ${entry.mode}) — it must be a symlink: ` +
            `${GIT} rm --cached -- ${quoted} && ln -sf -- ${LINK_TARGET} ${quoted} && ${GIT} add -- ${quoted}`,
        );
      } else if (entry.sha !== expectedSha) {
        // Comparing ids rather than bytes: a target with a trailing newline or
        // an embedded NUL is a different blob, whatever it renders as.
        const target = git(root, ["cat-file", "blob", entry.sha]).toString("utf8");
        findings.push(
          `${agents} is a symlink to ${JSON.stringify(target)} — it must point at the ${LINK_TARGET} beside it`,
        );
      }
      continue;
    }

    // Every remedy from here ends in `git add`, which refuses an ignored path
    // without -f — so the ignore rule is the finding, whatever else is wrong.
    // It holds even while the CLAUDE.md is itself untracked: the link cannot
    // follow it into a commit.
    if (isIgnored(root, agents)) {
      findings.push(
        `${agents} is matched by a gitignore rule, so the symlink cannot be tracked — un-ignore the path, then re-run`,
      );
      continue;
    }

    const onDisk = inspect(path.join(root, agents));
    if (onDisk.kind === "symlink") {
      if (onDisk.target !== LINK_TARGET) {
        findings.push(
          `${agents} is a symlink to ${JSON.stringify(onDisk.target)} — it must point at the ${LINK_TARGET} beside it`,
        );
      } else if (isTracked(root, claude)) {
        findings.push(
          `${agents} is not tracked by git, so it would be missing on a fresh checkout — run: ${GIT} add -- ${quoted}`,
        );
      }
      continue;
    }

    if (onDisk.kind === "directory") {
      // `ln -sf` would put the link inside it rather than replace it.
      findings.push(
        `${agents} is a directory — remove or rename it, then: ` +
          `ln -s -- ${LINK_TARGET} ${quoted} && ${GIT} add -- ${quoted}`,
      );
      continue;
    }

    if (onDisk.kind === "other") {
      findings.push(
        `${agents} exists but is not a symlink — replace it with: ` +
          `ln -sf -- ${LINK_TARGET} ${quoted} && ${GIT} add -- ${quoted}`,
      );
      continue;
    }

    findings.push(
      `${agents} is missing — create it with: ln -s -- ${LINK_TARGET} ${quoted} && ${GIT} add -- ${quoted}`,
    );
  }

  return { checked: claudeFiles.length, findings };
}

/** Prints the verdict. 0 clean, 1 findings, 2 the check could not run. */
export function runCli(cwd: string = process.cwd()): number {
  let result: LintResult;
  try {
    result = lintAgentsSymlinks(cwd);
  } catch (error) {
    // Exit 1 states that the invariant was checked and violated, so a crash
    // takes 2 like every other outcome where it was never checked at all.
    if (error instanceof LintEnvironmentError) {
      console.error(`check-agents-symlinks: ${error.message}`);
    } else {
      console.error("check-agents-symlinks: unexpected failure");
      console.error(error);
    }
    return 2;
  }

  // A repository checked out at its root always has one. Zero means the
  // enumeration broke, and reporting success would hide the broken lint.
  if (result.checked === 0) {
    console.error("check-agents-symlinks: found no CLAUDE.md files at all — the check did not run");
    return 2;
  }

  if (result.findings.length > 0) {
    for (const finding of result.findings) console.error(`  - ${finding}`);
    console.error(
      `check-agents-symlinks: ${result.findings.length} problem(s) found — each line above names its fix`,
    );
    return 1;
  }

  console.log(
    `check-agents-symlinks: ${result.checked} CLAUDE.md file(s) all have an AGENTS.md symlink`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
