import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";
import { createPiCredentialBoundary, inspectPiStoredCredential } from "./runtime.js";

describe("official Pi SDK credential adapter", () => {
  it("uses the installed SDK provider catalog without admitting excluded providers", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "rome-pi-catalog-"));
    try {
      const boundary = await createPiCredentialBoundary({ agentDir, environment: {} });
      const providers = boundary.listProviders().map((provider) => provider.id);

      expect(providers).toContain("anthropic");
      expect(providers).toContain("kimi-coding");
      expect(providers).toContain("moonshotai-cn");
      expect(providers).not.toContain("cloudflare-ai-gateway");
      expect(providers).not.toContain("openai-codex");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("writes a synthetic literal through Pi storage with restricted permissions", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "rome-pi-storage-"));
    const syntheticToken = "synthetic-test-token";
    try {
      const boundary = await createPiCredentialBoundary({ agentDir, environment: {} });
      const result = await boundary.saveCredential("anthropic", syntheticToken, {
        confirmReplace: false,
      });

      expect(result.credentialCommitted).toBe(true);
      expect(JSON.stringify(result)).not.toContain(syntheticToken);
      expect((await stat(join(agentDir, "auth.json"))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(agentDir, "auth.json"), "utf8")).toContain(syntheticToken);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("detects a stored command without executing it during status or refresh", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "rome-pi-expression-"));
    const marker = join(agentDir, "must-not-exist");
    const authPath = join(agentDir, "auth.json");
    await writeFile(
      authPath,
      JSON.stringify({ anthropic: { type: "api_key", key: `!touch ${marker}` } }),
      { mode: 0o600 },
    );
    try {
      expect(inspectPiStoredCredential("anthropic", authPath)).toBe("expression");
      const boundary = await createPiCredentialBoundary({ agentDir, environment: {} });

      const status = await boundary.refresh("anthropic");
      expect(status.catalog).toMatchObject({
        kind: "discovery-failed",
        failedProviders: ["anthropic"],
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
