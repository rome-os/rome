import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  PI_PROVIDER_ALLOWLIST,
  PiSettingsError,
  PiSettingsService,
  piRuntimePaths,
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

  it("uses a Rome-owned config path so Pi persists refreshed catalogs without loading models.json", () => {
    expect(piRuntimePaths("/tmp/pi-agent")).toEqual({
      authPath: "/tmp/pi-agent/auth.json",
      modelsPath: "/tmp/pi-agent/rome-models.json",
      modelsStorePath: "/tmp/pi-agent/models-cache.json",
    });
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

  it("does not reuse a pre-mutation status read after credential removal", async () => {
    let resolveInitialAuth: (() => void) | undefined;
    const initialAuth = new Promise<void>((resolve) => {
      resolveInitialAuth = resolve;
    });
    let initialProbeStarted: (() => void) | undefined;
    const probeStarted = new Promise<void>((resolve) => {
      initialProbeStarted = resolve;
    });
    let created = 0;
    const service = new PiSettingsService(async () => {
      created += 1;
      if (created === 1) {
        return {
          runtime: fakeRuntime({
            listCredentials: async () => [{ providerId: "kimi-coding", type: "api_key" }],
            checkAuth: async () => {
              initialProbeStarted?.();
              await initialAuth;
              return undefined;
            },
          }),
          dispose() {},
        };
      }
      if (created === 2) {
        return {
          runtime: fakeRuntime({
            listCredentials: async () => [{ providerId: "kimi-coding", type: "api_key" }],
          }),
          dispose() {},
        };
      }
      return { runtime: fakeRuntime(), dispose() {} };
    });

    const staleRead = service.status();
    await probeStarted;
    const removed = service.removeCredential("kimi-coding");
    resolveInitialAuth?.();
    await staleRead;
    expect(
      (await removed).providers.find((provider) => provider.id === "kimi-coding")?.credentialSource,
    ).toBe("none");
    expect(created).toBe(3);
  });

  it("requires replacement confirmation when concurrent saves target the same provider", async () => {
    let stored = false;
    let releaseInitialReads: (() => void) | undefined;
    const initialReads = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    const service = new PiSettingsService(async () => ({
      runtime: fakeRuntime({
        listCredentials: async () => {
          const snapshot = stored;
          if (!snapshot) await initialReads;
          return snapshot ? [{ providerId: "kimi-coding", type: "api_key" }] : [];
        },
        login: async () => {
          stored = true;
          return {};
        },
      }),
      dispose() {},
    }));

    const first = service.saveCredential({ providerId: "kimi-coding", token: "first-token" });
    await Promise.resolve();
    const second = service.saveCredential({ providerId: "kimi-coding", token: "second-token" });
    releaseInitialReads?.();

    await expect(first).resolves.toMatchObject({ credentialPersisted: true });
    await expect(second).rejects.toMatchObject({ code: "replace-required" });
  });

  it("bounds status probes and releases the shared request after an abort", async () => {
    const service = new PiSettingsService(
      async () => ({
        runtime: fakeRuntime({
          checkAuth: async (_providerId, options) =>
            await new Promise<undefined>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
            }),
        }),
        dispose() {},
      }),
      1,
    );

    await expect(service.status()).resolves.toMatchObject({
      catalogStatus: "discovery-failed",
      discoveryFailedProviders: ["kimi-coding"],
    });
  });

  it("bounds the post-save status read", async () => {
    const service = new PiSettingsService(
      async () => ({
        runtime: fakeRuntime({
          checkAuth: async (_providerId, options) =>
            await new Promise<undefined>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
            }),
        }),
        dispose() {},
      }),
      1,
    );

    await expect(
      service.saveCredential({ providerId: "kimi-coding", token: "opaque-token" }),
    ).resolves.toMatchObject({
      status: { catalogStatus: "discovery-failed", discoveryFailedProviders: ["kimi-coding"] },
    });
  });

  it("does not let an earlier provider mutation replace a newer cached status", async () => {
    let releaseFirstRefresh: (() => void) | undefined;
    const firstRefresh = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    let firstRefreshStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      firstRefreshStarted = resolve;
    });
    let created = 0;
    const service = new PiSettingsService(async () => {
      created += 1;
      const first = created === 1;
      const providerId = first ? "kimi-coding" : "moonshotai";
      const modelId = first ? "first-model" : "second-model";
      return {
        runtime: fakeRuntime({
          getProviders: () => [{ id: providerId, name: providerId }],
          checkAuth: async () => ({ type: "api_key" }),
          getAvailable: async () => [
            {
              id: modelId,
              name: modelId,
              provider: providerId,
              api: "openai-completions",
              input: ["text"],
              reasoning: false,
            },
          ],
          refresh: async () => {
            if (first) {
              firstRefreshStarted?.();
              await firstRefresh;
            }
            return { errors: new Map() };
          },
        }),
        dispose() {},
      };
    });

    const firstSave = service.saveCredential({ providerId: "kimi-coding", token: "first-token" });
    await firstStarted;
    const secondSave = service.saveCredential({ providerId: "moonshotai", token: "second-token" });
    await secondSave;
    releaseFirstRefresh?.();
    await firstSave;

    await expect(service.status()).resolves.toMatchObject({
      models: [expect.objectContaining({ qualifiedModelId: "moonshotai/second-model" })],
    });
  });

  it("recognizes Pi's exported synchronization error", async () => {
    const service = new PiSettingsService(async () => ({
      runtime: fakeRuntime({
        login: async () => {
          throw new CredentialSynchronizationError("kimi-coding", "login", undefined, {
            cause: new Error("catalog sync failed"),
          });
        },
      }),
      dispose() {},
    }));

    await expect(
      service.saveCredential({ providerId: "kimi-coding", token: "opaque-token" }),
    ).resolves.toMatchObject({
      credentialPersisted: true,
      synchronizationSucceeded: false,
    });
  });

  it("uses Pi-owned storage with 0600 permissions and never returns a token", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "rome-pi-production-"));
    const token = randomBytes(32).toString("hex");
    const replacementToken = randomBytes(32).toString("hex");
    const externalToken = randomBytes(32).toString("hex");
    const previousAnthropicToken = process.env.ANTHROPIC_API_KEY;
    const factory = async () => {
      const actual = await ModelRuntime.create({
        ...piRuntimePaths(agentDir),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      // Exercise the production-owned paths while keeping this persistence
      // test hermetic: catalog refresh networking is covered separately.
      const runtime = new Proxy(actual, {
        get(target, property) {
          if (property === "refresh") return async () => ({ errors: new Map() });
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PiModelRuntime;
      return { runtime, dispose() {} };
    };
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
