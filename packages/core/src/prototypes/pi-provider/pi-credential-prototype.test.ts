import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";
import { createPiModelRuntime } from "./pi-sdk-prototype.js";
import {
  listInstalledOneTokenProviders,
  readPiPrototypeConfiguration,
  removePiPrototypeCredential,
  savePiPrototypeCredential,
  validatePiPrototypeToken,
} from "./pi-credential-prototype.js";

describe("Pi credential configuration prototype", () => {
  it("accepts opaque literal tokens and rejects executable or unsafe forms", () => {
    expect(validatePiPrototypeToken("  literal-token  ")).toEqual({
      ok: true,
      token: "literal-token",
    });
    for (const value of [
      "",
      "   ",
      "$TOKEN",
      "${TOKEN}",
      "!secret-command",
      "one\ntwo",
      "a\u0000b",
    ]) {
      const result = validatePiPrototypeToken(value);
      expect(result.ok).toBe(false);
      if (value) expect(JSON.stringify(result)).not.toContain(value);
    }
    expect(validatePiPrototypeToken("x".repeat(8_193)).ok).toBe(false);
  });

  it("exposes only the reviewed intersection of installed Pi providers", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "rome-pi-provider-catalog-"));
    try {
      const runtime = await createPiModelRuntime({ agentDir, refreshOnCreate: false });
      const providers = listInstalledOneTokenProviders(runtime);
      expect(providers).toContainEqual({ id: "anthropic", name: "Anthropic" });
      expect(providers.some((provider) => provider.id === "cloudflare-ai-gateway")).toBe(false);
      expect(providers.some((provider) => provider.id === "openai-codex")).toBe(false);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("writes through Pi storage, never returns the token, and reveals external precedence after removal", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "rome-pi-provider-credential-"));
    const previousEnvironmentToken = process.env.ANTHROPIC_API_KEY;
    const externalToken = randomBytes(24).toString("hex");
    const storedToken = randomBytes(24).toString("hex");
    process.env.ANTHROPIC_API_KEY = externalToken;
    try {
      const runtime = await createPiModelRuntime({ agentDir, refreshOnCreate: false });
      const saved = await savePiPrototypeCredential("anthropic", storedToken, false, runtime);
      const savedProvider = saved.status.providers.find((provider) => provider.id === "anthropic");
      expect(saved.credentialPersisted).toBe(true);
      expect(savedProvider).toMatchObject({
        configured: true,
        credentialSource: "stored",
        storedCredentialType: "api_key",
      });
      expect(JSON.stringify(saved)).not.toContain(storedToken);
      expect((await stat(join(agentDir, "auth.json"))).mode & 0o777).toBe(0o600);

      const removed = await removePiPrototypeCredential("anthropic", runtime);
      const removedProvider = removed.status.providers.find(
        (provider) => provider.id === "anthropic",
      );
      expect(removed.credentialRemoved).toBe(true);
      expect(removedProvider).toMatchObject({
        configured: true,
        credentialSource: "environment",
        externalSource: "ANTHROPIC_API_KEY",
      });
      expect(JSON.stringify(removed)).not.toContain(externalToken);

      const refreshed = await readPiPrototypeConfiguration(runtime);
      expect(refreshed.liveValidity).toBe("not-verified");
    } finally {
      if (previousEnvironmentToken === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousEnvironmentToken;
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
