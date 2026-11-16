import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ActionConfig } from "@rome-os/app-runtime";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSigner } from "../../../../packages/signer/src/signer.js";
import { createAction as createApply } from "./vault-apply/index.js";
import { createAction as createSearch } from "./vault-search/index.js";

const apply = createApply({ name: "vault_apply", type: "system" } as ActionConfig);
const search = createSearch({ name: "vault_search", type: "system" } as ActionConfig);

const cleanups: Array<() => void> = [];
afterEach(() => {
  rs.unstubAllEnvs();
  while (cleanups.length) cleanups.pop()?.();
});

async function startVault() {
  const dir = mkdtempSync(join(tmpdir(), "vault-actions-"));
  const socketPath = join(dir, "signer.sock");
  const { server } = await startSigner({
    audience: "https://cloud.example",
    keyDir: join(dir, "keys"),
    socketPath,
    log: () => {},
  });
  cleanups.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  rs.stubEnv("ROME_SIGNER_SOCKET", socketPath);
  await new Promise<void>((resolve, reject) => {
    const req = request({ socketPath, method: "PUT", path: "/v1/secrets/GITHUB_TOKEN" }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end(JSON.stringify({ value: "ghp_topsecret", description: "CI token" }));
  });
}

describe("vault_apply", () => {
  it("is described for agents and requires input", () => {
    expect(apply.config.name).toBe("vault_apply");
    expect(apply.inputSchema.required).toEqual(["name", "reason"]);
  });

  it("previews a secret-access card, with title and summary for surfaces that draw only the generic one", () => {
    expect(apply.preview?.({ name: "GITHUB_TOKEN", reason: "Push the release tag" })).toEqual({
      kind: "secret_access",
      name: "GITHUB_TOKEN",
      ttlMinutes: 15,
      reason: "Push the release tag",
      title: "Use GITHUB_TOKEN for 15 min",
      summary: "Push the release tag",
    });
    expect(apply.preview?.({ name: "GITHUB_TOKEN", ttlMinutes: 60, reason: "r" })).toMatchObject({
      kind: "secret_access",
      ttlMinutes: 60,
      title: "Use GITHUB_TOKEN for 60 min",
    });
  });

  it("grants for 15 minutes by default and points at the CLI", async () => {
    await startVault();
    const before = Date.now();
    const result = await apply.execute({ name: "GITHUB_TOKEN", reason: "Push the tag" });
    expect(result.status).toBe("ok");
    const data = (result as { data: { name: string; expiresAt: string; message: string } }).data;
    expect(data.name).toBe("GITHUB_TOKEN");
    expect(Date.parse(data.expiresAt) - before).toBeGreaterThan(14 * 60_000);
    expect(Date.parse(data.expiresAt) - before).toBeLessThanOrEqual(15 * 60_000 + 5000);
    expect(data.message).toContain("vault load GITHUB_TOKEN -- <command>");
    expect(JSON.stringify(data)).not.toContain("topsecret");
  });

  it.each([
    { name: "GITHUB_TOKEN", reason: "r", ttlMinutes: 0 },
    { name: "GITHUB_TOKEN", reason: "r", ttlMinutes: 181 },
    { name: "GITHUB_TOKEN", reason: "r", ttlMinutes: 1.5 },
    { name: "GITHUB_TOKEN", reason: " " },
    { name: "github_token", reason: "r" },
    { name: "GITHUB_TOKEN", reason: "r", extra: true },
  ])("rejects invalid input %j", async (input) => {
    await startVault();
    expect((await apply.execute(input)).status).toBe("error");
  });

  it("reports an unknown secret", async () => {
    await startVault();
    const result = await apply.execute({ name: "MISSING_KEY", reason: "r" });
    expect(result).toMatchObject({ status: "error" });
    expect((result as { error: string }).error).toContain("MISSING_KEY");
  });

  it("explains when there is no signer", async () => {
    rs.stubEnv("ROME_SIGNER_SOCKET", "");
    expect(await apply.execute({ name: "GITHUB_TOKEN", reason: "r" })).toEqual({
      status: "error",
      error: "The vault needs the signer, which is not running on this instance.",
    });
  });
});

describe("vault_search", () => {
  it("lists metadata without values, and shows a live grant", async () => {
    await startVault();
    await apply.execute({ name: "GITHUB_TOKEN", ttlMinutes: 5, reason: "r" });
    const result = await search.execute({});
    expect(result.status).toBe("ok");
    const { secrets } = (result as { data: { secrets: Array<Record<string, unknown>> } }).data;
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({
      name: "GITHUB_TOKEN",
      description: "CI token",
      lastUsedAt: null,
    });
    expect(typeof secrets[0].grantedUntil).toBe("string");
    expect(JSON.stringify(result)).not.toContain("topsecret");
  });

  it("filters by query and is read-only without approval", async () => {
    await startVault();
    const miss = await search.execute({ query: "stripe" });
    expect((miss as { data: { secrets: unknown[] } }).data.secrets).toEqual([]);
    const hit = await search.execute({ query: "ci tok" });
    expect((hit as { data: { secrets: unknown[] } }).data.secrets).toHaveLength(1);
    expect(search.preview).toBeUndefined();
  });
});
