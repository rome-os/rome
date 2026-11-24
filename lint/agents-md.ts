#!/usr/bin/env tsx
/**
 * Make sure agent instructions live only in AGENTS.md files.
 *
 * Claude Code skips AGENTS.md files when a CLAUDE.md or CLAUDE.local.md takes
 * their place, and one at the root hides every nested AGENTS.md too. So any
 * file by those names is a finding.
 *
 * Untracked files that are not ignored count, so a new CLAUDE.md fails before
 * it is committed rather than on the PR that adds it.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BANNED = ["CLAUDE.md", "CLAUDE.local.md"];

/** The invariant could not be evaluated. Never reported as a pass. */
export class LintEnvironmentError extends Error {}

export type LintResult = { findings: string[] };

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw new LintEnvironmentError(`git ${args.join(" ")} failed: ${result.error.message}`);
  }
  const stderr = result.stderr.toString().trim();
  // ls-files exits 0 after warning that it could not read a directory, so a
  // whole subtree can go unexamined behind a clean verdict.
  if (result.status !== 0 || stderr) {
    throw new LintEnvironmentError(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout.toString("utf8");
}

/**
 * Reports every CLAUDE.md and CLAUDE.local.md, and a missing root AGENTS.md.
 *
 * Throws LintEnvironmentError when the repository cannot be read at all.
 */
export function lintAgentsMd(cwd: string = process.cwd()): LintResult {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();

  // -z keeps git from C-quoting non-ASCII paths (core.quotePath).
  const listing = git(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...BANNED.flatMap((name) => [name, `*/${name}`]),
  ]);
  // A conflicted path is listed once per index stage, the pathspec also
  // matches the children of a directory that carries a banned name, and the
  // index still lists a file deleted on disk but not yet staged.
  const banned = [...new Set(listing.split("\0"))]
    .filter((file) => BANNED.includes(path.basename(file)))
    .filter((file) => existsSync(path.join(root, file)))
    .sort();

  const findings = banned.map((file) => {
    const agents = path.join(path.dirname(file), "AGENTS.md");
    return `${file} hides AGENTS.md files from Claude Code — move its content into ${agents}, then delete it`;
  });
  // Without a root AGENTS.md, a clean verdict could only mean the listing broke.
  if (!existsSync(path.join(root, "AGENTS.md"))) {
    findings.push("AGENTS.md is missing at the repository root");
  }
  return { findings };
}

/** Prints the verdict. 0 clean, 1 findings, 2 the check could not run. */
export function runCli(cwd: string = process.cwd()): number {
  let result: LintResult;
  try {
    result = lintAgentsMd(cwd);
  } catch (error) {
    // Exit 1 states that the invariant was checked and violated, so a crash
    // takes 2 like every other outcome where it was never checked at all.
    if (error instanceof LintEnvironmentError) {
      console.error(`agents-md: ${error.message}`);
    } else {
      console.error("agents-md: unexpected failure");
      console.error(error);
    }
    return 2;
  }

  if (result.findings.length > 0) {
    for (const finding of result.findings) console.error(`  - ${finding}`);
    console.error(`agents-md: ${result.findings.length} problem(s) found`);
    return 1;
  }

  console.log("agents-md: agent instructions are in AGENTS.md files only");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
