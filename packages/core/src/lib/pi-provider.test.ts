import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  PI_PROVIDER_ALLOWLIST,
  PiSettingsError,
  PiSettingsService,
  hardenPiAuthFilePermissions,
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
    for (const value of [
      "",
      "   ",
      "$TOKEN",
      "${TOKEN}",
      "prefix$HOME",
      "!command",
      "a\nb",
      "x".repeat(8_193),
    ]) {
      try {
        validatePiToken(value);
        throw new Error("expected token validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(PiSettingsError);
        if (value.trim()) expect(String(error)).not.toContain(value);
      }
    }
    expect(validatePiToken("  opaque-token  ")).toBe("opaque-token");
    expect(validatePiToken("opaque-token\n")).toBe("opaque-token");
    expect(validatePiToken("opaque-token\r\n")).toBe("opaque-token");
    expect(validatePiToken(`${"x".repeat(8_192)}\n`)).toHaveLength(8_192);
  });

  it("explicitly disables Pi model configuration", () => {
    expect(piRuntimePaths("/tmp/pi-agent")).toEqual({
      authPath: "/tmp/pi-agent/auth.json",
      modelsPath: null,
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

  it("does not let runtime disposal mask a status result or mutation error", async () => {
    const successful = new PiSettingsService(async () => ({
      runtime: fakeRuntime(),
      dispose() {
        throw new Error("dispose failed");
      },
    }));
    await expect(successful.status()).resolves.toMatchObject({ catalogStatus: "no-models" });

    const rejected = new PiSettingsService(async () => ({
      runtime: fakeRuntime({
        listCredentials: async () => [{ providerId: "kimi-coding", type: "api_key" }],
      }),
      dispose() {
        throw new Error("dispose failed");
      },
    }));
    await expect(
      rejected.saveCredential({ providerId: "kimi-coding", token: "opaque-token" }),
    ).rejects.toMatchObject({ code: "replace-required" });
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
            listCredentials: async () => [],
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

  it("does not cache a status read that began while a credential save was in progress", async () => {
    let stored = false;
    let releaseLogin: (() => void) | undefined;
    const loginCanFinish = new Promise<void>((resolve) => {
      releaseLogin = resolve;
    });
    let loginStarted: (() => void) | undefined;
    const loginHasStarted = new Promise<void>((resolve) => {
      loginStarted = resolve;
    });
    let staleProbeStarted: (() => void) | undefined;
    const staleProbe = new Promise<void>((resolve) => {
      staleProbeStarted = resolve;
    });
    let releaseStaleProbe: (() => void) | undefined;
    const staleProbeCanFinish = new Promise<void>((resolve) => {
      releaseStaleProbe = resolve;
    });
    let created = 0;
    const service = new PiSettingsService(async () => {
      created += 1;
      if (created === 1) {
        return {
          runtime: fakeRuntime({
            listCredentials: async () =>
              stored ? [{ providerId: "kimi-coding", type: "api_key" }] : [],
            login: async () => {
              loginStarted?.();
              await loginCanFinish;
              stored = true;
            },
          }),
          dispose() {},
        };
      }
      return {
        runtime: fakeRuntime({
          listCredentials: async () => [],
          checkAuth: async () => {
            staleProbeStarted?.();
            await staleProbeCanFinish;
            return undefined;
          },
        }),
        dispose() {},
      };
    });

    const save = service.saveCredential({ providerId: "kimi-coding", token: "opaque-token" });
    await loginHasStarted;
    const staleRead = service.status();
    await staleProbe;
    releaseLogin?.();
    await save;
    releaseStaleProbe?.();
    await staleRead;

    expect(
      (await service.status()).providers.find((provider) => provider.id === "kimi-coding")
        ?.credentialSource,
    ).toBe("stored");
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

  it("rejects a non-cooperative status probe and clears the shared in-flight read", async () => {
    let created = 0;
    const service = new PiSettingsService(async () => {
      created += 1;
      return {
        runtime:
          created === 1
            ? fakeRuntime({ checkAuth: async () => await new Promise<never>(() => {}) })
            : fakeRuntime(),
        dispose() {},
      };
    }, 1);

    await expect(service.status()).rejects.toThrow("timed out");
    await expect(service.status()).resolves.toMatchObject({ catalogStatus: "no-models" });
    expect(created).toBe(2);
  });

  it("rejects a non-cooperative post-save status read without wedging mutations", async () => {
    let created = 0;
    const service = new PiSettingsService(async () => {
      created += 1;
      return {
        runtime:
          created === 1
            ? fakeRuntime({ checkAuth: async () => await new Promise<never>(() => {}) })
            : fakeRuntime(),
        dispose() {},
      };
    }, 1);

    await expect(
      service.saveCredential({ providerId: "kimi-coding", token: "opaque-token" }),
    ).rejects.toThrow("timed out");
    await expect(service.removeCredential("kimi-coding")).resolves.toMatchObject({
      catalogStatus: "no-models",
    });
    expect(created).toBe(3);
  });

  it("serializes different-provider mutations that share Pi auth storage", async () => {
    let releaseFirstLogin: (() => void) | undefined;
    const firstLogin = new Promise<void>((resolve) => {
      releaseFirstLogin = resolve;
    });
    let firstLoginStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      firstLoginStarted = resolve;
    });
    let created = 0;
    const service = new PiSettingsService(async () => {
      created += 1;
      const first = created === 1;
      const providerId = first ? "kimi-coding" : "moonshotai";
      return {
        runtime: fakeRuntime({
          getProviders: () => [{ id: providerId, name: providerId }],
          login: async () => {
            if (first) {
              firstLoginStarted?.();
              await firstLogin;
            }
            return {};
          },
        }),
        dispose() {},
      };
    });

    const firstSave = service.saveCredential({ providerId: "kimi-coding", token: "first-token" });
    await firstStarted;
    const secondSave = service.saveCredential({ providerId: "moonshotai", token: "second-token" });
    await Promise.resolve();
    expect(created).toBe(1);

    releaseFirstLogin?.();
    await Promise.all([firstSave, secondSave]);
    expect(created).toBe(2);
  });

  it("does not create an unhandled rejection when a status runtime fails", async () => {
    const service = new PiSettingsService(async () => {
      throw new Error("runtime creation failed");
    });

    await expect(service.status()).rejects.toThrow("runtime creation failed");
  });

  it("bounds Pi login before it can hold the mutation queue indefinitely", async () => {
    const service = new PiSettingsService(
      async () => ({
        runtime: fakeRuntime({
          login: async (_providerId, _type, interaction) =>
            await new Promise<never>((_resolve, reject) => {
              interaction.signal?.addEventListener("abort", () =>
                reject(interaction.signal?.reason),
              );
            }),
        }),
        dispose() {},
      }),
      1,
    );

    await expect(
      service.saveCredential({ providerId: "kimi-coding", token: "opaque-token" }),
    ).rejects.toBeDefined();
  });

  it("reports a committed credential when login times out during synchronization", async () => {
    let stored = false;
    const service = new PiSettingsService(
      async () => ({
        runtime: fakeRuntime({
          listCredentials: async () =>
            stored ? [{ providerId: "kimi-coding", type: "api_key" }] : [],
          login: async () =>
            await new Promise<never>(() => {
              stored = true;
            }),
        }),
        dispose() {},
      }),
      1,
    );

    await expect(
      service.saveCredential({ providerId: "kimi-coding", token: "opaque-token" }),
    ).resolves.toMatchObject({
      credentialPersisted: true,
      synchronizationSucceeded: false,
      status: {
        providers: [expect.objectContaining({ id: "kimi-coding", credentialSource: "stored" })],
      },
    });
  });

  it("releases the shared mutation queue when an SDK call ignores its abort signal", async () => {
    let created = 0;
    const service = new PiSettingsService(async () => {
      created += 1;
      if (created === 1) {
        return {
          runtime: fakeRuntime({ listCredentials: async () => await new Promise<never>(() => {}) }),
          dispose() {},
        };
      }
      return { runtime: fakeRuntime(), dispose() {} };
    }, 1);

    await expect(
      service.saveCredential({ providerId: "kimi-coding", token: "opaque-token" }),
    ).rejects.toThrow("timed out");
    await expect(service.removeCredential("kimi-coding")).resolves.toMatchObject({
      providers: [expect.objectContaining({ id: "kimi-coding", credentialSource: "none" })],
    });
    expect(created).toBe(3);
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
      credentialPersisted: false,
      synchronizationSucceeded: false,
    });
  });

  it("discovers a literal credential saved by this service", async () => {
    let stored = false;
    let availableCalls = 0;
    const service = new PiSettingsService(async () => ({
      runtime: fakeRuntime({
        listCredentials: async () =>
          stored ? [{ providerId: "kimi-coding", type: "api_key" }] : [],
        login: async () => {
          stored = true;
        },
        getAvailable: async () => {
          availableCalls += 1;
          return [
            {
              id: "kimi-k2",
              name: "Kimi K2",
              provider: "kimi-coding",
              api: "openai-completions",
              input: ["text"],
              reasoning: true,
            },
          ];
        },
      }),
      isStoredCredentialLiteral: async (providerId) => providerId === "kimi-coding" && stored,
      dispose() {},
    }));

    await expect(
      service.saveCredential({ providerId: "kimi-coding", token: "opaque-token" }),
    ).resolves.toMatchObject({
      credentialPersisted: true,
      status: { models: [expect.objectContaining({ providerId: "kimi-coding" })] },
    });
    expect(availableCalls).toBe(1);
  });

  it("re-inspects shared Pi auth before later stored-credential discovery", async () => {
    let stored = false;
    let literal = true;
    let availableCalls = 0;
    const service = new PiSettingsService(async () => ({
      runtime: fakeRuntime({
        listCredentials: async () =>
          stored ? [{ providerId: "kimi-coding", type: "api_key" }] : [],
        login: async () => {
          stored = true;
        },
        getAvailable: async () => {
          availableCalls += 1;
          return [];
        },
      }),
      isStoredCredentialLiteral: async (providerId) =>
        providerId === "kimi-coding" && stored && literal,
      dispose() {},
    }));

    await service.saveCredential({ providerId: "kimi-coding", token: "opaque-token" });
    const callsAfterSave = availableCalls;
    literal = false; // Simulate a concurrent Pi CLI edit to a !command/$template credential.

    await expect(service.status({ bypassCache: true })).resolves.toMatchObject({
      providers: [expect.objectContaining({ id: "kimi-coding", credentialSource: "stored" })],
    });
    expect(availableCalls).toBe(callsAfterSave);
  });

  it("returns refreshed models from the runtime that refreshed them", async () => {
    const service = new PiSettingsService(async () => {
      let refreshed = false;
      return {
        runtime: fakeRuntime({
          listCredentials: async () => [{ providerId: "kimi-coding", type: "api_key" }],
          refresh: async () => {
            refreshed = true;
            return { errors: new Map() };
          },
          getAvailable: async () =>
            refreshed
              ? [
                  {
                    id: "kimi-k2",
                    name: "Kimi K2",
                    provider: "kimi-coding",
                    api: "openai-completions",
                    input: ["text"],
                    reasoning: true,
                  },
                ]
              : [],
        }),
        isStoredCredentialLiteral: async () => true,
        dispose() {},
      };
    });

    await expect(service.refreshProvider("kimi-coding")).resolves.toMatchObject({
      models: [expect.objectContaining({ qualifiedModelId: "kimi-coding/kimi-k2" })],
    });
  });

  it("does not resolve pre-existing stored credentials while reading status", async () => {
    let checkAuthCalls = 0;
    let availableCalls = 0;
    const service = new PiSettingsService(async () => ({
      runtime: fakeRuntime({
        listCredentials: async () => [{ providerId: "kimi-coding", type: "api_key" }],
        checkAuth: async () => {
          checkAuthCalls += 1;
          throw new Error("must not resolve stored auth");
        },
        getAvailable: async () => {
          availableCalls += 1;
          throw new Error("must not resolve stored auth");
        },
      }),
      dispose() {},
    }));

    await expect(service.status()).resolves.toMatchObject({
      providers: [
        expect.objectContaining({
          id: "kimi-coding",
          credentialSource: "stored",
          storedCredentialType: "api_key",
          modelCount: 0,
        }),
      ],
    });
    expect(checkAuthCalls).toBe(0);
    expect(availableCalls).toBe(0);
  });

  it("does not execute a command credential from Pi auth storage", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "rome-pi-command-"));
    const marker = join(agentDir, "command-ran");
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({
        "kimi-coding": { type: "api_key", key: `!touch ${marker}` },
      }),
      { mode: 0o600 },
    );
    const factory = async () => ({
      runtime: (await ModelRuntime.create({
        ...piRuntimePaths(agentDir),
        allowModelNetwork: false,
        refreshOnCreate: false,
      })) as unknown as PiModelRuntime,
      dispose() {},
    });
    try {
      const service = new PiSettingsService(factory);
      const status = await service.status();
      expect(status.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "kimi-coding", credentialSource: "stored" }),
        ]),
      );
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("ignores a hostile Rome-named model config", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "rome-pi-model-config-"));
    await writeFile(
      join(agentDir, "rome-models.json"),
      JSON.stringify({
        providers: {
          hostile: {
            baseUrl: "https://example.invalid/v1",
            api: "openai-completions",
            models: [{ id: "injected", name: "Injected", input: ["text"] }],
          },
        },
      }),
    );
    try {
      const runtime = await ModelRuntime.create({
        ...piRuntimePaths(agentDir),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      expect(runtime.getProviders().some((provider) => provider.id === "hostile")).toBe(false);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("hardens the auth file before handing a token to Pi", async () => {
    let stored = false;
    let hardenCalls = 0;
    const service = new PiSettingsService(async () => ({
      runtime: fakeRuntime({
        listCredentials: async () =>
          stored ? [{ providerId: "kimi-coding", type: "api_key" }] : [],
        login: async () => {
          expect(hardenCalls).toBe(1);
          stored = true;
        },
      }),
      hardenAuthFilePermissions: async () => {
        hardenCalls += 1;
      },
      dispose() {},
    }));

    await expect(
      service.saveCredential({ providerId: "kimi-coding", token: "opaque-token" }),
    ).resolves.toMatchObject({ credentialPersisted: true });
    expect(hardenCalls).toBe(2);
  });

  it("tightens an existing Pi auth file before a credential mutation", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "rome-pi-auth-mode-"));
    const authPath = join(agentDir, "auth.json");
    try {
      await writeFile(authPath, "{}", { mode: 0o600 });
      await chmod(authPath, 0o644);
      await hardenPiAuthFilePermissions(authPath);
      expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("refuses a symlink in place of Pi auth storage", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "rome-pi-auth-symlink-"));
    const authPath = join(agentDir, "auth.json");
    const target = join(agentDir, "target.json");
    try {
      await writeFile(target, "{}", { mode: 0o600 });
      await symlink(target, authPath);
      await expect(hardenPiAuthFilePermissions(authPath)).rejects.toThrow("not a regular file");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("reconciles a timed-out logout that already removed the credential", async () => {
    let stored = true;
    let created = 0;
    const service = new PiSettingsService(async () => {
      created += 1;
      return {
        runtime: fakeRuntime({
          listCredentials: async () =>
            stored ? [{ providerId: "kimi-coding", type: "api_key" }] : [],
          logout: async () => {
            stored = false;
            await new Promise<never>(() => {});
          },
        }),
        dispose() {},
      };
    }, 1);

    await expect(service.removeCredential("kimi-coding")).resolves.toMatchObject({
      providers: [expect.objectContaining({ id: "kimi-coding", credentialSource: "none" })],
    });
    expect(created).toBe(2);
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
