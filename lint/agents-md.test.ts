import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { lintAgentsMd } from "./agents-md.js";

const execFileAsync = promisify(execFile);

let repo: string;

function lint(): string[] {
  return lintAgentsMd(repo).findings;
}

async function write(file: string): Promise<void> {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), "# guidance\n");
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "agents-md-lint-"));
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await write("AGENTS.md");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("lintAgentsMd", () => {
  it("passes when every instruction file is an AGENTS.md", async () => {
    await write("packages/web/AGENTS.md");

    expect(lint()).toEqual([]);
  });

  it("reports a CLAUDE.md at the root and in a nested folder", async () => {
    await write("CLAUDE.md");
    await write("docs/CLAUDE.md");

    expect(lint()).toEqual([
      "CLAUDE.md hides AGENTS.md files from Claude Code — move its content into AGENTS.md, then delete it",
      "docs/CLAUDE.md hides AGENTS.md files from Claude Code — move its content into docs/AGENTS.md, then delete it",
    ]);
  });

  it("reports a CLAUDE.local.md that is not ignored", async () => {
    await write("CLAUDE.local.md");

    expect(lint()).toHaveLength(1);
  });

  it("leaves a gitignored CLAUDE.local.md to its owner", async () => {
    await write("CLAUDE.local.md");
    await writeFile(path.join(repo, ".gitignore"), "CLAUDE.local.md\n");

    expect(lint()).toEqual([]);
  });

  it("skips the children of a directory named CLAUDE.md", async () => {
    await write("docs/CLAUDE.md/notes");

    expect(lint()).toEqual([]);
  });

  it("reports a missing root AGENTS.md", async () => {
    await rm(path.join(repo, "AGENTS.md"));

    expect(lint()).toEqual(["AGENTS.md is missing at the repository root"]);
  });
});
