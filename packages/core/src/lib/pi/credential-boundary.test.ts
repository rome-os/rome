import { randomBytes } from "node:crypto";
import { describe, expect, it, rs } from "@rstest/core";
import {
  PiCredentialBoundary,
  PiCredentialBoundaryError,
  type PiAuthStatus,
  type PiCredentialInfo,
  type PiCredentialRuntime,
  type PiRefreshResult,
  type PiStoredCredentialSafety,
  validatePiToken,
} from "./credential-boundary.js";
import type { PiSdkModel, PiSdkProvider } from "./catalog.js";

class SynchronizationFailure extends Error {}

function provider(id: string): PiSdkProvider {
  return { id, auth: { apiKey: { login() {} } } };
}

function model(providerId: string, id: string, api = "anthropic-messages"): PiSdkModel {
  return {
    id,
    name: `${providerId} ${id}`,
    provider: providerId,
    api,
    input: ["text"],
    reasoning: false,
  };
}

class FakePiRuntime implements PiCredentialRuntime {
  readonly providers = [provider("anthropic"), provider("openai"), provider("groq")];
  readonly models: PiSdkModel[] = [
    model("anthropic", "shared/model"),
    model("openai", "shared/model", "openai-responses"),
    model("groq", "llama", "openai-completions"),
  ];
  readonly credentials = new Map<string, PiCredentialInfo["type"]>();
  readonly authStatuses = new Map<string, PiAuthStatus>();
  readonly mutations: Array<{ operation: "save" | "remove"; providerId: string }> = [];
  readonly refreshCalls: string[][] = [];
  readonly availableCalls: string[] = [];
  loginError?: Error;
  logoutError?: Error;
  refreshResult: PiRefreshResult = { aborted: false, errors: new Map() };
  refreshError?: Error;
  submittedValue?: string;

  getProviders() {
    return this.providers;
  }

  getProvider(providerId: string) {
    return this.providers.find((item) => item.id === providerId);
  }

  getModels(providerId?: string) {
    return providerId ? this.models.filter((item) => item.provider === providerId) : this.models;
  }

  async listCredentials() {
    return [...this.credentials].map(([providerId, type]) => ({ providerId, type }));
  }

  getProviderAuthStatus(providerId: string) {
    return this.authStatuses.get(providerId) ?? { configured: false };
  }

  async getAvailable(providerId: string) {
    this.availableCalls.push(providerId);
    return this.getModels(providerId);
  }

  async login(
    providerId: string,
    _type: "api_key",
    interaction: Parameters<PiCredentialRuntime["login"]>[2],
  ) {
    this.submittedValue = await interaction.prompt({ type: "secret" });
    this.credentials.set(providerId, "api_key");
    this.mutations.push({ operation: "save", providerId });
    if (this.loginError) throw this.loginError;
  }

  async logout(providerId: string) {
    this.credentials.delete(providerId);
    this.mutations.push({ operation: "remove", providerId });
    if (this.logoutError) throw this.logoutError;
  }

  async refresh(options: Parameters<PiCredentialRuntime["refresh"]>[0]) {
    this.refreshCalls.push([...options.providers]);
    if (this.refreshError) throw this.refreshError;
    return this.refreshResult;
  }

  getError(): never {
    throw new Error("unrelated SDK aggregate error");
  }
}

function createBoundary(
  runtime = new FakePiRuntime(),
  options: {
    environment?: Readonly<Record<string, string | undefined>>;
    safety?: Readonly<Record<string, PiStoredCredentialSafety>>;
  } = {},
) {
  return {
    runtime,
    boundary: new PiCredentialBoundary({
      runtime,
      environment: options.environment ?? {},
      inspectStoredCredential: (providerId) => options.safety?.[providerId] ?? "literal",
      isCredentialSynchronizationError: (error) => error instanceof SynchronizationFailure,
      refreshTimeoutMs: 100,
    }),
  };
}

describe("Pi token validation", () => {
  it("accepts and trims an opaque literal token", () => {
    expect(validatePiToken("  opaque-token  ")).toEqual({ ok: true, token: "opaque-token" });
  });

  it.each([
    ["not a string", undefined, "required"],
    ["empty", "   ", "required"],
    ["too long", "x".repeat(8_193), "too-long"],
    ["line feed", "one\ntwo", "control-character"],
    ["carriage return", "one\rtwo", "control-character"],
    ["tab", "one\ttwo", "control-character"],
    ["NUL", "one\u0000two", "control-character"],
    ["C1 control", "one\u0085two", "control-character"],
    ["Unicode line separator", "one\u2028two", "control-character"],
    ["environment expression", "$TOKEN", "expression-prefix"],
    ["braced environment expression", "${TOKEN}", "expression-prefix"],
    ["command expression", "!get-token", "expression-prefix"],
  ])("rejects %s without echoing it", (_name, input, reason) => {
    const result = validatePiToken(input);
    expect(result).toMatchObject({ ok: false, reason });
    if (typeof input === "string" && input.length > 0) {
      expect(JSON.stringify(result)).not.toContain(input);
    }
  });

  it("accepts the exact length limit", () => {
    expect(validatePiToken("x".repeat(8_192)).ok).toBe(true);
    expect(validatePiToken(`  ${"x".repeat(8_192)}  `)).toMatchObject({
      ok: true,
      token: "x".repeat(8_192),
    });
  });
});

describe("Pi credential boundary", () => {
  it("reports stored, environment, external, and absent credential sources without values", async () => {
    const runtime = new FakePiRuntime();
    runtime.credentials.set("anthropic", "oauth");
    runtime.authStatuses.set("groq", { configured: true, source: "runtime", label: "secret" });
    const environmentSecret = randomBytes(24).toString("hex");
    const { boundary } = createBoundary(runtime, {
      environment: { OPENAI_API_KEY: environmentSecret },
      safety: { anthropic: "oauth" },
    });

    const status = await boundary.readStatus();
    expect(status.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "anthropic",
          credentialSource: "stored",
          storedCredentialType: "oauth",
        }),
        expect.objectContaining({ id: "openai", credentialSource: "environment" }),
        expect.objectContaining({ id: "groq", credentialSource: "external" }),
      ]),
    );
    expect(JSON.stringify(status)).not.toContain(environmentSecret);
    expect(JSON.stringify(status)).not.toContain("secret");

    runtime.authStatuses.delete("groq");
    const withoutExternal = await boundary.readStatus();
    expect(withoutExternal.providers.find((item) => item.id === "groq")).toMatchObject({
      configured: false,
      credentialSource: "none",
      status: "not-configured",
    });
  });

  it("requires confirmation before replacing a stored API key or OAuth credential", async () => {
    for (const credentialType of ["api_key", "oauth"] as const) {
      const runtime = new FakePiRuntime();
      runtime.credentials.set("anthropic", credentialType);
      const { boundary } = createBoundary(runtime, {
        safety: { anthropic: credentialType === "oauth" ? "oauth" : "literal" },
      });

      await expect(
        boundary.saveCredential("anthropic", "replacement", { confirmReplace: false }),
      ).rejects.toMatchObject({ code: "replacement-confirmation-required" });
      expect(runtime.mutations).toHaveLength(0);

      const result = await boundary.saveCredential("anthropic", "replacement", {
        confirmReplace: true,
      });
      expect(result.replacedStoredCredential).toBe(true);
      expect(runtime.mutations).toEqual([{ operation: "save", providerId: "anthropic" }]);
    }
  });

  it("does not mutate for any rejected token", async () => {
    const { boundary, runtime } = createBoundary();
    for (const input of ["", " ", "$TOKEN", "!command", "one\ntwo", "x".repeat(8_193)]) {
      await expect(
        boundary.saveCredential("anthropic", input, { confirmReplace: false }),
      ).rejects.toMatchObject({ code: "invalid-token" });
    }
    expect(runtime.mutations).toHaveLength(0);
  });

  it("stores embedded interpolation markers as escaped literals", async () => {
    const { boundary, runtime } = createBoundary();
    await boundary.saveCredential("anthropic", "opaque$TOKEN", { confirmReplace: false });
    expect(runtime.submittedValue).toBe("opaque$$TOKEN");
  });

  it("removes only the confirmed provider-scoped stored credential", async () => {
    const runtime = new FakePiRuntime();
    runtime.credentials.set("anthropic", "api_key");
    runtime.credentials.set("openai", "api_key");
    const externalSecret = randomBytes(24).toString("hex");
    const { boundary } = createBoundary(runtime, {
      environment: { ANTHROPIC_API_KEY: externalSecret },
    });

    await expect(
      boundary.removeStoredCredential("anthropic", { confirmRemove: false }),
    ).rejects.toMatchObject({ code: "removal-confirmation-required" });
    expect(runtime.mutations).toHaveLength(0);

    const result = await boundary.removeStoredCredential("anthropic", { confirmRemove: true });
    expect(result.credentialRemoved).toBe(true);
    expect(runtime.credentials.has("anthropic")).toBe(false);
    expect(runtime.credentials.has("openai")).toBe(true);
    expect(result.status.providers.find((item) => item.id === "anthropic")).toMatchObject({
      credentialSource: "environment",
      configured: true,
    });
    expect(JSON.stringify(result)).not.toContain(externalSecret);
  });

  it("does not claim to remove an external-only credential", async () => {
    const runtime = new FakePiRuntime();
    runtime.authStatuses.set("anthropic", { configured: true, source: "fallback" });
    const { boundary } = createBoundary(runtime);

    const result = await boundary.removeStoredCredential("anthropic", { confirmRemove: true });
    expect(result.credentialRemoved).toBe(false);
    expect(runtime.mutations).toHaveLength(0);
    expect(result.status.providers.find((item) => item.id === "anthropic")).toMatchObject({
      credentialSource: "external",
      configured: true,
    });
  });

  it("returns a distinct no-models result without claiming token validity", async () => {
    const runtime = new FakePiRuntime();
    runtime.credentials.set("anthropic", "api_key");
    runtime.models.splice(
      0,
      runtime.models.length,
      model("anthropic", "unsupported", "future-api"),
    );
    const { boundary } = createBoundary(runtime);

    const status = await boundary.readStatus();
    expect(status.catalog).toEqual({ kind: "no-models", models: [] });
    expect(status.liveValidity).toBe("not-verified");
    expect(status.providers.find((item) => item.id === "anthropic")?.status).toBe("no-models");
  });

  it("distinguishes a committed credential from later synchronization failure", async () => {
    const runtime = new FakePiRuntime();
    runtime.loginError = new SynchronizationFailure("raw SDK detail");
    const { boundary } = createBoundary(runtime);

    const result = await boundary.saveCredential("anthropic", "opaque-token", {
      confirmReplace: false,
    });
    expect(result).toMatchObject({
      credentialCommitted: true,
      synchronizationSucceeded: false,
      status: { catalog: { kind: "discovery-failed", failedProviders: ["anthropic"] } },
    });
    expect(JSON.stringify(result)).not.toContain("raw SDK detail");
  });

  it("retains successful models when another provider refresh fails", async () => {
    const runtime = new FakePiRuntime();
    runtime.credentials.set("anthropic", "api_key");
    runtime.credentials.set("openai", "api_key");
    runtime.refreshResult = {
      aborted: false,
      errors: new Map([["openai", new Error("secret-bearing provider failure")]]),
    };
    const { boundary } = createBoundary(runtime);

    const status = await boundary.refresh();
    expect(status.catalog).toMatchObject({
      kind: "discovery-failed",
      failedProviders: ["openai"],
    });
    expect(status.catalog.models.map((item) => item.qualifiedModelId)).toEqual([
      "anthropic/shared%2Fmodel",
    ]);
    expect(JSON.stringify(status)).not.toContain("secret-bearing provider failure");
  });

  it("reports target-provider synchronization independently of another provider failure", async () => {
    const runtime = new FakePiRuntime();
    runtime.credentials.set("openai", "api_key");
    const { boundary } = createBoundary(runtime, { safety: { openai: "expression" } });

    const result = await boundary.saveCredential("anthropic", "opaque-token", {
      confirmReplace: false,
    });

    expect(result.synchronizationSucceeded).toBe(true);
    expect(result.status.catalog).toMatchObject({
      kind: "discovery-failed",
      failedProviders: ["openai"],
    });
    expect(result.status.providers.find((provider) => provider.id === "anthropic")).toMatchObject({
      status: "models-available",
    });
  });

  it("does not treat an unrelated runtime aggregate error as every provider's failure", async () => {
    const runtime = new FakePiRuntime();
    runtime.credentials.set("anthropic", "api_key");
    const { boundary } = createBoundary(runtime);

    const status = await boundary.readStatus();

    expect(status.catalog).toMatchObject({ kind: "models-available" });
    expect(status.providers.find((item) => item.id === "anthropic")).toMatchObject({
      status: "models-available",
    });
  });

  it("does not resolve or refresh a stored credential expression", async () => {
    const runtime = new FakePiRuntime();
    runtime.credentials.set("anthropic", "api_key");
    const { boundary } = createBoundary(runtime, { safety: { anthropic: "expression" } });

    const status = await boundary.refresh("anthropic");
    expect(runtime.refreshCalls).toHaveLength(0);
    expect(runtime.availableCalls).toHaveLength(0);
    expect(status).toMatchObject({
      catalog: { kind: "discovery-failed", failedProviders: ["anthropic"] },
    });
    expect(status.catalog.models).toEqual([]);
  });

  it("does not resolve or refresh an external credential expression", async () => {
    const runtime = new FakePiRuntime();
    runtime.authStatuses.set("anthropic", {
      configured: true,
      source: "models_json_command",
    });
    const { boundary } = createBoundary(runtime);

    const status = await boundary.refresh("anthropic");
    expect(runtime.refreshCalls).toHaveLength(0);
    expect(runtime.availableCalls).toHaveLength(0);
    expect(status).toMatchObject({
      catalog: { kind: "discovery-failed", failedProviders: ["anthropic"] },
    });
  });

  it("sanitizes SDK failures and never logs or returns the submitted secret", async () => {
    const submittedSecret = randomBytes(32).toString("hex");
    const runtime = new FakePiRuntime();
    runtime.loginError = new Error(`SDK rejected ${submittedSecret}`);
    const { boundary } = createBoundary(runtime);
    const log = rs.spyOn(console, "log").mockImplementation(() => {});
    const warn = rs.spyOn(console, "warn").mockImplementation(() => {});
    const error = rs.spyOn(console, "error").mockImplementation(() => {});

    try {
      let publicError: unknown;
      try {
        await boundary.saveCredential("anthropic", submittedSecret, { confirmReplace: false });
      } catch (caught) {
        publicError = caught;
      }
      expect(publicError).toBeInstanceOf(PiCredentialBoundaryError);
      expect(publicError).toMatchObject({ code: "credential-save-failed" });
      expect(String(publicError)).not.toContain(submittedSecret);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("keeps successful results secret-free", async () => {
    const submittedSecret = randomBytes(32).toString("hex");
    const { boundary } = createBoundary();
    const result = await boundary.saveCredential("anthropic", submittedSecret, {
      confirmReplace: false,
    });

    expect(result.credentialCommitted).toBe(true);
    expect(result.status.catalog.kind).toBe("models-available");
    expect(JSON.stringify(result)).not.toContain(submittedSecret);
  });
});
