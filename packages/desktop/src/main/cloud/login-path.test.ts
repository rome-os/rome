import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "@rstest/core";
import { loginShellPath, withHomebrewDirs } from "./login-path";

function fakeShell(body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "login-path-")), "shell");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("loginShellPath", () => {
  it("reads PATH from between the markers, ignoring startup output", async () => {
    // Stands in for a login shell: prints a banner, then runs the command.
    const shell = fakeShell('echo "Welcome back"\nPATH=/opt/homebrew/bin:/usr/bin sh -c "$2"');
    expect(await loginShellPath(shell)).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("gives up on a shell that hangs", async () => {
    const shell = fakeShell("sleep 5");
    expect(await loginShellPath(shell, 200)).toBeNull();
  });

  it("returns null without a shell", async () => {
    expect(await loginShellPath("")).toBeNull();
  });
});

describe("withHomebrewDirs", () => {
  it("puts the Homebrew directories first when they are missing", () => {
    expect(withHomebrewDirs("/usr/bin:/bin")).toBe(
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    );
  });

  it("leaves a PATH that has them alone", () => {
    expect(withHomebrewDirs("/usr/local/bin:/usr/bin:/opt/homebrew/bin")).toBe(
      "/usr/local/bin:/usr/bin:/opt/homebrew/bin",
    );
  });
});
