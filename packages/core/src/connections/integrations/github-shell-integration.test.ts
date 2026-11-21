import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

const childProcess = rs.hoisted(() => ({
  spawn: rs.fn(),
}));

rs.mock("node:child_process", () => ({
  spawn: childProcess.spawn,
}));

import {
  clearGithubShellIntegrationForProvider,
  syncGithubShellIntegrationForProvider,
} from "./github-shell-integration.js";

function mockGhSuccess() {
  childProcess.spawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter & { setEncoding: ReturnType<typeof rs.fn> };
      stdin: { end: ReturnType<typeof rs.fn> };
      kill: ReturnType<typeof rs.fn>;
    };
    child.stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof rs.fn> };
    child.stderr.setEncoding = rs.fn();
    child.stdin = { end: rs.fn() };
    child.kill = rs.fn();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
}

describe("github shell integration", () => {
  const originalGhToken = process.env.GH_TOKEN;
  const originalGithubToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    childProcess.spawn.mockReset();
    mockGhSuccess();
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    if (originalGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = originalGhToken;
    }
    if (originalGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalGithubToken;
    }
  });

  // The on-disk token file is owned by provider-token-files.ts; this module only
  // configures the gh/git CLI auth (covered in provider-token-files.test.ts).
  it("persists gh auth without exporting token env", async () => {
    process.env.GH_TOKEN = "ambient-gh-token";
    process.env.GITHUB_TOKEN = "ambient-github-token";

    await syncGithubShellIntegrationForProvider("github", {
      accessToken: " gho_test_token\n",
    });

    expect(childProcess.spawn).toHaveBeenNthCalledWith(
      1,
      "gh",
      ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"],
      expect.objectContaining({
        env: expect.not.objectContaining({
          GH_TOKEN: expect.any(String),
          GITHUB_TOKEN: expect.any(String),
        }),
      }),
    );
    expect(childProcess.spawn).toHaveBeenNthCalledWith(
      2,
      "gh",
      ["auth", "setup-git", "--hostname", "github.com"],
      expect.any(Object),
    );
  });

  it("logs gh out on disconnect", async () => {
    await clearGithubShellIntegrationForProvider("github");

    expect(childProcess.spawn).toHaveBeenCalledWith(
      "gh",
      ["auth", "logout", "--hostname", "github.com", "--yes"],
      expect.any(Object),
    );
  });
});
