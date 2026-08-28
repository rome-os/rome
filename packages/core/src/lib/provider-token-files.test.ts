import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import {
  clearProviderTokenFile,
  getProviderTokenFilePath,
  syncProviderTokenFile,
} from "./provider-token-files.js";

describe("provider token files", () => {
  let tempDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rome-provider-token-files-"));
    for (const key of [
      "ROME_GITHUB_TOKEN_FILE",
      "ROME_SLACK_TOKEN_FILE",
      "ROME_GOOGLE_TOKEN_FILE",
    ]) {
      savedEnv[key] = process.env[key];
    }
    process.env.ROME_GITHUB_TOKEN_FILE = join(tempDir, "github-oauth-token");
    process.env.ROME_SLACK_TOKEN_FILE = join(tempDir, "slack-oauth-token");
    process.env.ROME_GOOGLE_TOKEN_FILE = join(tempDir, "google-oauth-token");
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("resolves the path from the per-provider env override", () => {
    expect(getProviderTokenFilePath("github")).toBe(join(tempDir, "github-oauth-token"));
    expect(getProviderTokenFilePath("slack")).toBe(join(tempDir, "slack-oauth-token"));
  });

  it("writes GitHub as a bare token line and trims whitespace", async () => {
    await syncProviderTokenFile("github", { accessToken: " gho_test_token\n" }, {});

    const file = getProviderTokenFilePath("github");
    expect(readFileSync(file, "utf8")).toBe("gho_test_token\n");
    // 0o640 so the shared-fs reader (shell wrapper / connector) can read it.
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  it("writes Slack as JSON carrying the bot token, user token, and team id", async () => {
    // botToken/userToken are secret material; teamId is the non-secret profile.
    await syncProviderTokenFile(
      "slack",
      { botToken: "xoxb-bot", userToken: "xoxp-user" },
      { teamId: "T123" },
    );

    const file = getProviderTokenFilePath("slack");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      botToken: "xoxb-bot",
      userToken: "xoxp-user",
      teamId: "T123",
    });
  });

  it("writes Slack with null user token / team id when absent from material/profile", async () => {
    await syncProviderTokenFile("slack", { botToken: "xoxb-bot" }, {});

    expect(JSON.parse(readFileSync(getProviderTokenFilePath("slack"), "utf8"))).toEqual({
      botToken: "xoxb-bot",
      userToken: null,
      teamId: null,
    });
  });

  it("clears the file when the material carries no usable access token", async () => {
    const file = getProviderTokenFilePath("github");
    writeFileSync(file, "stale\n");

    await syncProviderTokenFile("github", { accessToken: "  " }, {});
    expect(existsSync(file)).toBe(false);
  });

  it("removes the file on disconnect (and tolerates a missing file)", async () => {
    const file = getProviderTokenFilePath("slack");
    await syncProviderTokenFile("slack", { botToken: "xoxb-bot" }, {});
    expect(existsSync(file)).toBe(true);

    await clearProviderTokenFile("slack");
    expect(existsSync(file)).toBe(false);
    // Idempotent: clearing an already-absent file does not throw.
    await expect(clearProviderTokenFile("slack")).resolves.toBeUndefined();
  });

  it("owns no file for a provider without a file consumer (google)", async () => {
    await syncProviderTokenFile("google", { accessToken: "ya29.token" }, {});
    expect(existsSync(getProviderTokenFilePath("google"))).toBe(false);
  });
});
