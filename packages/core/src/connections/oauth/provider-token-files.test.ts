import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import {
  clearProviderTokenFile,
  getProviderTokenFilePath,
  removeRetiredTokenFiles,
  syncProviderTokenFile,
} from "./provider-token-files.js";

describe("provider token files", () => {
  let tempDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rome-provider-token-files-"));
    for (const key of [
      "ROME_GITHUB_TOKEN_FILE",
      "ROME_GOOGLE_TOKEN_FILE",
      "ROME_SHOPIFY_TOKEN_FILE",
      "ROME_SLACK_TOKEN_FILE",
    ]) {
      savedEnv[key] = process.env[key];
    }
    process.env.ROME_GITHUB_TOKEN_FILE = join(tempDir, "github-oauth-token");
    process.env.ROME_GOOGLE_TOKEN_FILE = join(tempDir, "google-oauth-token");
    process.env.ROME_SHOPIFY_TOKEN_FILE = join(tempDir, "shopify-oauth-token");
    process.env.ROME_SLACK_TOKEN_FILE = join(tempDir, "slack-oauth-token");
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("resolves the path from the per-provider env override", () => {
    expect(getProviderTokenFilePath("github")).toBe(join(tempDir, "github-oauth-token"));
    expect(getProviderTokenFilePath("shopify")).toBe(join(tempDir, "shopify-oauth-token"));
  });

  it("writes GitHub as a bare token line and trims whitespace", async () => {
    await syncProviderTokenFile("github", { accessToken: " gho_test_token\n" }, {});

    const file = getProviderTokenFilePath("github");
    expect(readFileSync(file, "utf8")).toBe("gho_test_token\n");
    // 0o640 so the shared-fs reader (shell wrapper / connector) can read it.
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  it("writes Shopify as JSON carrying the access token and the store's domain", async () => {
    // The token is secret material; the store's myshopify.com domain is the
    // profile's `login`, which the connector uses as the Admin API host.
    await syncProviderTokenFile(
      "shopify",
      { accessToken: "shpat_live", refreshToken: "shprt_live" },
      { login: "acme.myshopify.com" },
    );

    // The refresh token stays in core: the connector never refreshes.
    expect(JSON.parse(readFileSync(getProviderTokenFilePath("shopify"), "utf8"))).toEqual({
      accessToken: "shpat_live",
      shop: "acme.myshopify.com",
    });
  });

  it("writes no Shopify file without the store's domain", async () => {
    await syncProviderTokenFile("shopify", { accessToken: "shpat_live" }, {});
    expect(existsSync(getProviderTokenFilePath("shopify"))).toBe(false);
  });

  it("clears the file when the material carries no usable access token", async () => {
    const file = getProviderTokenFilePath("github");
    writeFileSync(file, "stale\n");

    await syncProviderTokenFile("github", { accessToken: "  " }, {});
    expect(existsSync(file)).toBe(false);
  });

  it("removes the file on disconnect (and tolerates a missing file)", async () => {
    const file = getProviderTokenFilePath("github");
    await syncProviderTokenFile("github", { accessToken: "gho_test_token" }, {});
    expect(existsSync(file)).toBe(true);

    await clearProviderTokenFile("github");
    expect(existsSync(file)).toBe(false);
    // Idempotent: clearing an already-absent file does not throw.
    await expect(clearProviderTokenFile("github")).resolves.toBeUndefined();
  });

  it("owns no file for a provider without a file consumer (google)", async () => {
    await syncProviderTokenFile("google", { accessToken: "ya29.token" }, {});
    expect(existsSync(getProviderTokenFilePath("google"))).toBe(false);
  });

  it("removes the Slack sign-in's token file an older build left, and keeps the others", async () => {
    const slack = join(tempDir, "slack-oauth-token");
    writeFileSync(slack, "xoxp-left-behind\n");
    writeFileSync(getProviderTokenFilePath("github"), "gho_kept\n");

    await removeRetiredTokenFiles();

    expect(existsSync(slack)).toBe(false);
    expect(existsSync(getProviderTokenFilePath("github"))).toBe(true);
    // Nothing left to remove is fine.
    await expect(removeRetiredTokenFiles()).resolves.toBeUndefined();
  });
});
