import { describe, expect, it } from "@rstest/core";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { executableExistsOnPath, extractComposioLoginUrl } from "./composio-cli.js";

describe("Composio CLI helpers", () => {
  it("extracts the dashboard login URL from CLI output", () => {
    const output = [
      "Open this URL to complete login:",
      "https://dashboard.composio.dev/?cliKey=94619b20-37cb-4353-ba36-5a3d0a6ef836",
    ].join("\n");

    expect(extractComposioLoginUrl(output)).toBe(
      "https://dashboard.composio.dev/?cliKey=94619b20-37cb-4353-ba36-5a3d0a6ef836",
    );
  });

  it("extracts the login URL from the v0.2.32 multi-line text output", () => {
    // The CLI pinned in the Dockerfile prints human-readable text (and points at
    // `composio login --poll` for completion) rather than the old JSON.
    const output = [
      "Open this URL in your browser to log in:",
      "",
      "  https://dashboard.composio.dev/?cliKey=59aea532-0e11-47ba-bc1c-62e7ab242117",
      "",
      "Then run this command to complete login:",
      "",
      "  composio login --poll",
    ].join("\n");

    expect(extractComposioLoginUrl(output)).toBe(
      "https://dashboard.composio.dev/?cliKey=59aea532-0e11-47ba-bc1c-62e7ab242117",
    );
  });

  it("ignores non-Composio URLs", () => {
    expect(extractComposioLoginUrl("https://example.com/?cliKey=abc")).toBeNull();
  });

  it("detects an executable by searching PATH entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rome-composio-cli-"));
    try {
      const executable = join(dir, "composio");
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o755);

      await expect(executableExistsOnPath("composio", dir)).resolves.toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not treat directories or non-executable files as installed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rome-composio-cli-"));
    try {
      const binDir = join(dir, "bin");
      const nonExecutableDir = join(dir, "non-executable");
      await mkdir(join(binDir, "composio"), { recursive: true });
      await writeFile(join(dir, "composio"), "not executable\n", { mode: 0o644 });

      await expect(
        executableExistsOnPath("composio", [binDir, nonExecutableDir, dir].join(delimiter)),
      ).resolves.toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects command names that already include a path", async () => {
    await expect(executableExistsOnPath("./composio", process.env.PATH ?? "")).resolves.toBe(false);
  });
});
