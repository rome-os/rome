import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { createHistoryHandler, resolveNearestGitTarget } from "./file-browser-server.js";

describe("file browser Git history", () => {
  let rootDir: string;
  let projectDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "rome-file-history-"));
    projectDir = join(rootDir, "demo");
    mkdirSync(projectDir);
    git("init", "--quiet");
    writeFileSync(join(projectDir, "notes.md"), "# Shell pipelines\n");
    git("add", "notes.md");
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function git(...args: string[]): string {
    return execFileSync(
      "git",
      [
        "-c",
        "user.name=Rome Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "-c",
        `core.hooksPath=${join(projectDir, "no-hooks")}`,
        ...args,
      ],
      {
        cwd: projectDir,
        encoding: "utf-8",
        env: {
          PATH: process.env.PATH,
          HOME: rootDir,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
    ).trim();
  }

  it.each([
    "docs: explain shell pipelines",
    "docs: explain cat notes.txt | sort",
    "docs: explain cat notes.txt | sort | uniq",
    "docs: 说明管道  cat notes.txt  |  sort | uniq",
    "| docs: explain shell pipelines |",
  ])("returns the full subject and author date for %s", async (subject) => {
    git("commit", "--quiet", "-m", subject);
    const hash = git("rev-parse", "HEAD");
    const date = git("show", "-s", "--format=%aI", "HEAD");
    const app = new Hono();
    app.get(
      "/api/projects/history",
      createHistoryHandler({
        assetBasePath: "/api/projects/asset",
        logicalRoot: "projects",
        rootDir,
        historyTarget: (resolvedPath) => resolveNearestGitTarget(rootDir, resolvedPath),
      }),
    );

    const response = await app.request("/api/projects/history?path=projects/demo/notes.md");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ date, hash, message: subject }]);
  });
});
