import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  PI_PROVIDER_ALLOWLIST,
  PiSettingsError,
  PiSettingsService,
  qualifyPiModel,
  validatePiToken,
  type PiModelRuntime,
} from "./pi-provider.js";

function fakeRuntime(overrides: Partial<PiModelRuntime> = {}): PiModelRuntime {
  return {
    getProviders: () => [{ id: "kimi-coding", name: "Kimi For Coding" }],
    listCredentials: async () => [],
    checkAuth: async () => undefined,
    getAvailable: async () => [],
    login: async () => ({}),
    logout: async () => {},
    refresh: async () => ({ errors: new Map() }),
    ...overrides,
  };
}

describe("Pi settings service", () => {
  it("rejects empty and indirection tokens without echoing them", () => {
    for (const value of ["", "   ", "$TOKEN", "${TOKEN}", "!command", "a\nb", "x".repeat(8_193)]) {
      try {
        validatePiToken(value);
        throw new Error("expected token validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(PiSettingsError);
        if (value.trim()) expect(String(error)).not.toContain(value);
      }
    }
    expect(validatePiToken("  opaque-token  ")).toBe("opaque-token");
  });

  it("keeps Kimi For Coding and both Moonshot credential slots distinct", () => {
    expect(PI_PROVIDER_ALLOWLIST).toContainEqual(["kimi-coding", "Kimi For Coding"]);
    expect(PI_PROVIDER_ALLOWLIST).toContainEqual([
      "moonshotai",
      "Moonshot AI (global Kimi Platform)",
    ]);
    expect(PI_PROVIDER_ALLOWLIST).toContainEqual([
      "moonshotai-cn",
      "Moonshot AI China (Kimi Platform)",
    ]);
    expect(qualifyPiModel("moonshotai-cn", "kimi/k2")).toBe("moonshotai-cn/kimi%2Fk2");
  });

  it("bounds status work, sanitizes external labels, and disposes runtimes", async () => {
    let created = 0;
    let disposed = 0;
    const service = new PiSettingsService(async () => {
      created += 1;
      return {
        runtime: fakeRuntime({
          getProviders: () => [
            { id: "kimi-coding", name: "Kimi For Coding" },
            { id: "custom-provider", name: "Custom provider" },
          ],
          checkAuth: async () => ({ type: "api_key", source: "secret-looking path" }),
          getAvailable: async () => [
            {
              id: "kimi-k2",
              name: "Kimi K2",
              provider: "kimi-coding",
              api: "openai-completions",
              input: ["text"],
              reasoning: true,
            },
          ],
        }),
        dispose: () => {
          disposed += 1;
        },
      };
    });
    const [first, second] = await Promise.all([service.status(), service.status()]);
    expect(first).toEqual(second);
    expect(created).toBe(1);
    expect(disposed).toBe(1);
    expect(first.providers[0]).toMatchObject({
      credentialSource: "environment",
      externalSource: "external",
    });
    expect(first.models[0]?.qualifiedModelId).toBe("kimi-coding/kimi-k2");
    expect(first.providers.some((provider) => provider.id === "custom-provider")).toBe(false);
    await service.status();
    expect(created).toBe(1);
  });

  it("uses Pi-owned storage with 0600 permissions and never returns a token", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "rome-pi-production-"));
    const token = randomBytes(32).toString("hex");
    const replacementToken = randomBytes(32).toString("hex");
    const externalToken = randomBytes(32).toString("hex");
    const previousAnthropicToken = process.env.ANTHROPIC_API_KEY;
    const factory = async () => ({
      runtime: (await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(agentDir, "models-cache.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      })) as PiModelRuntime,
      dispose() {},
    });
    try {
      const service = new PiSettingsService(factory);
      const result = await service.saveCredential({ providerId: "kimi-coding", token });
      expect(result.credentialPersisted).toBe(true);
      expect(JSON.stringify(result)).not.toContain(token);
      expect((await stat(join(agentDir, "auth.json"))).mode & 0o777).toBe(0o600);
      expect(
        result.status.providers.find((provider) => provider.id === "kimi-coding"),
      ).toMatchObject({
        name: "Kimi For Coding",
        credentialSource: "stored",
        storedCredentialType: "api_key",
      });
      expect(result.status.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "moonshotai",
            name: "Moonshot AI (global Kimi Platform)",
          }),
          expect.objectContaining({
            id: "moonshotai-cn",
            name: "Moonshot AI China (Kimi Platform)",
          }),
        ]),
      );
      await expect(
        service.saveCredential({ providerId: "kimi-coding", token: replacementToken }),
      ).rejects.toMatchObject({ code: "replace-required" });
      await expect(
        service.saveCredential({
          providerId: "kimi-coding",
          token: replacementToken,
          confirmReplace: true,
        }),
      ).resolves.toMatchObject({ credentialPersisted: true });
      const removed = await service.removeCredential("kimi-coding");
      expect(
        removed.providers.find((provider) => provider.id === "kimi-coding")?.credentialSource,
      ).toBe("none");

      process.env.ANTHROPIC_API_KEY = externalToken;
      const environmentService = new PiSettingsService(factory);
      const external = await environmentService.status();
      expect(external.providers.find((provider) => provider.id === "anthropic")).toMatchObject({
        credentialSource: "environment",
        externalSource: "ANTHROPIC_API_KEY",
      });
      expect(JSON.stringify(external)).not.toContain(externalToken);
      await environmentService.saveCredential({ providerId: "anthropic", token });
      const removedStored = await environmentService.removeCredential("anthropic");
      expect(removedStored.providers.find((provider) => provider.id === "anthropic")).toMatchObject(
        {
          credentialSource: "environment",
          externalSource: "ANTHROPIC_API_KEY",
        },
      );
    } finally {
      if (previousAnthropicToken === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropicToken;
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
