import { describe, expect, it } from "@rstest/core";
import {
  decodePiModelId,
  encodePiModelId,
  normalizePiAccounting,
  PiCatalog,
  PiConfiguration,
  type PiRuntimeCredentialStatus,
  type PiRuntimeModel,
  type PiRuntimeMutationResult,
  type PiRuntimeOperations,
} from "./pi-provider-boundary.js";

function eligibleModel(
  upstreamProvider: string,
  upstreamModel: string,
  overrides: Partial<PiRuntimeModel> = {},
): PiRuntimeModel {
  return {
    upstreamProvider,
    upstreamModel,
    displayName: upstreamModel,
    input: ["text"],
    origin: "built-in",
    romeCompatibility: "reviewed-text-and-tools",
    ...overrides,
  };
}

class FakeRuntime implements PiRuntimeOperations {
  installedProviderIds: string[] = ["anthropic", "openai"];
  models = new Map<string, PiRuntimeModel[]>([
    ["anthropic", [eligibleModel("anthropic", "claude-test")]],
    ["openai", [eligibleModel("openai", "gpt-test")]],
  ]);
  credentials = new Map<string, PiRuntimeCredentialStatus>();
  saveCalls: Array<{ providerId: string; token: string }> = [];
  removeCalls: string[] = [];
  refreshCalls: string[] = [];
  saveSynchronization: PiRuntimeMutationResult["synchronization"] = "succeeded";
  removeSynchronization: PiRuntimeMutationResult["synchronization"] = "succeeded";
  catalogErrors = new Map<string, unknown>();
  saveError?: unknown;
  removeError?: unknown;

  async listInstalledProviderIds(): Promise<readonly string[]> {
    return this.installedProviderIds;
  }

  async listAvailableModels(providerId: string): Promise<readonly PiRuntimeModel[]> {
    const error = this.catalogErrors.get(providerId);
    if (error) throw error;
    return this.models.get(providerId) ?? [];
  }

  async getCredentialStatus(providerId: string): Promise<PiRuntimeCredentialStatus> {
    return this.credentials.get(providerId) ?? {};
  }

  async saveLiteralToken(providerId: string, token: string): Promise<PiRuntimeMutationResult> {
    this.saveCalls.push({ providerId, token });
    if (this.saveError) throw this.saveError;
    const credential = {
      stored: { type: "api_key" as const },
      external: this.credentials.get(providerId)?.external,
    };
    this.credentials.set(providerId, credential);
    return { credential, synchronization: this.saveSynchronization };
  }

  async removeStoredCredential(providerId: string): Promise<PiRuntimeMutationResult> {
    this.removeCalls.push(providerId);
    if (this.removeError) throw this.removeError;
    const existing = this.credentials.get(providerId);
    const credential = existing?.external ? { external: existing.external } : {};
    this.credentials.set(providerId, credential);
    return { credential, synchronization: this.removeSynchronization };
  }

  async refreshProvider(providerId: string): Promise<"succeeded" | "failed"> {
    this.refreshCalls.push(providerId);
    return "succeeded";
  }
}

describe("Pi provider boundary", () => {
  it("round-trips collision-safe qualified model IDs and rejects noncanonical input", () => {
    const left = encodePiModelId({
      upstreamProvider: "custom/provider",
      upstreamModel: "org/model/v2",
    });
    const right = encodePiModelId({
      upstreamProvider: "custom",
      upstreamModel: "provider/org/model/v2",
    });

    expect(left).toBe("custom%2Fprovider/org%2Fmodel%2Fv2");
    expect(right).toBe("custom/provider%2Forg%2Fmodel%2Fv2");
    expect(left).not.toBe(right);
    expect(decodePiModelId(left)).toEqual({
      upstreamProvider: "custom/provider",
      upstreamModel: "org/model/v2",
    });

    for (const invalid of [
      "bare-model",
      "/model",
      "provider/",
      "one/two/three",
      "provider/bad%2fcanonical",
      "provider/bad%",
      "provider/model%00",
    ]) {
      expect(() => decodePiModelId(invalid)).toThrow();
      try {
        decodePiModelId(invalid);
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain(invalid);
      }
    }
  });

  it("intersects the closed reviewed, installed, built-in, text, and tool-ready catalog", async () => {
    const runtime = new FakeRuntime();
    runtime.installedProviderIds = [
      "openai",
      "anthropic",
      "cloudflare-ai-gateway",
      "future-provider",
    ];
    runtime.models.set("anthropic", [
      eligibleModel("anthropic", "eligible"),
      eligibleModel("anthropic", "custom", { origin: "custom" }),
      eligibleModel("anthropic", "image-only", { input: ["image"] }),
      eligibleModel("anthropic", "unreviewed", { romeCompatibility: "unreviewed" }),
      eligibleModel("different-provider", "mismatch"),
    ]);
    runtime.models.set("openai", [eligibleModel("openai", "same/model")]);
    runtime.models.set("cloudflare-ai-gateway", [
      eligibleModel("cloudflare-ai-gateway", "excluded"),
    ]);

    const result = await new PiCatalog(runtime).listEligible();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.providers).toEqual([
      { id: "anthropic", name: "Anthropic" },
      { id: "openai", name: "OpenAI" },
    ]);
    expect(result.snapshot.models).toEqual([
      {
        qualifiedModelId: "anthropic/eligible",
        upstreamProvider: "anthropic",
        upstreamModel: "eligible",
        providerName: "Anthropic",
        displayName: "eligible",
        input: ["text"],
      },
      {
        qualifiedModelId: "openai/same%2Fmodel",
        upstreamProvider: "openai",
        upstreamModel: "same/model",
        providerName: "OpenAI",
        displayName: "same/model",
        input: ["text"],
      },
    ]);
  });

  it("reports stored, external, and absent credentials without values", async () => {
    const runtime = new FakeRuntime();
    runtime.installedProviderIds = ["anthropic", "openai", "groq"];
    runtime.models.set("groq", []);
    runtime.credentials.set("anthropic", {
      stored: { type: "oauth" },
      external: { kind: "environment" },
    });
    runtime.credentials.set("openai", { external: { kind: "environment" } });

    const result = await new PiConfiguration(runtime).status();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.status.providers.map(({ id, configured, credential }) => ({
        id,
        configured,
        credential,
      })),
    ).toEqual([
      {
        id: "anthropic",
        configured: true,
        credential: { source: "stored", storedType: "oauth" },
      },
      {
        id: "openai",
        configured: true,
        credential: { source: "external", externalKind: "environment" },
      },
      { id: "groq", configured: false, credential: { source: "none" } },
    ]);
    expect(result.status.liveValidity).toBe("not-verified");
  });

  it("rejects unsafe literal tokens and unconfirmed replacement before mutation", async () => {
    const runtime = new FakeRuntime();
    const configuration = new PiConfiguration(runtime);
    const invalidTokens: unknown[] = [
      undefined,
      "",
      "   ",
      "$TOKEN",
      " ${TOKEN}",
      "!credential-command",
      "one\ntwo",
      "one\u0000two",
      "x".repeat(8_193),
    ];

    for (const token of invalidTokens) {
      const result = await configuration.saveLiteralToken({
        providerId: "anthropic",
        token,
        confirmReplace: false,
      });
      expect(result.ok).toBe(false);
      if (typeof token === "string" && token.length > 0) {
        expect(JSON.stringify(result)).not.toContain(token);
      }
    }
    expect(runtime.saveCalls).toEqual([]);

    runtime.credentials.set("anthropic", { stored: { type: "api_key" } });
    const unconfirmed = await configuration.saveLiteralToken({
      providerId: "anthropic",
      token: "replacement-token",
      confirmReplace: false,
    });
    expect(unconfirmed).toMatchObject({
      ok: false,
      error: { code: "replace-confirmation-required" },
    });
    expect(runtime.saveCalls).toEqual([]);

    const unsupported = await configuration.saveLiteralToken({
      providerId: "future-provider",
      token: "valid-token",
      confirmReplace: true,
    });
    expect(unsupported).toMatchObject({
      ok: false,
      error: { code: "unsupported-provider" },
    });
    expect(runtime.saveCalls).toEqual([]);
  });

  it("scopes confirmed replacement and removal to one provider", async () => {
    const runtime = new FakeRuntime();
    const configuration = new PiConfiguration(runtime);
    runtime.credentials.set("anthropic", {
      stored: { type: "api_key" },
      external: { kind: "environment" },
    });
    runtime.credentials.set("openai", { stored: { type: "oauth" } });

    const saved = await configuration.saveLiteralToken({
      providerId: "anthropic",
      token: "  new-anthropic-token  ",
      confirmReplace: true,
    });
    expect(saved.ok).toBe(true);
    expect(runtime.saveCalls).toEqual([{ providerId: "anthropic", token: "new-anthropic-token" }]);
    expect(runtime.credentials.get("openai")).toEqual({ stored: { type: "oauth" } });

    const notConfirmed = await configuration.removeStoredCredential({
      providerId: "anthropic",
      confirmRemove: false,
    });
    expect(notConfirmed).toMatchObject({
      ok: false,
      error: { code: "remove-confirmation-required" },
    });
    expect(runtime.removeCalls).toEqual([]);

    const removed = await configuration.removeStoredCredential({
      providerId: "anthropic",
      confirmRemove: true,
    });
    expect(removed).toMatchObject({
      ok: true,
      credentialRemoved: true,
      status: {
        providers: [
          {
            id: "anthropic",
            credential: { source: "external", externalKind: "environment" },
          },
        ],
      },
    });
    expect(runtime.removeCalls).toEqual(["anthropic"]);
    expect(runtime.credentials.get("openai")).toEqual({ stored: { type: "oauth" } });
  });

  it("keeps a committed credential distinct from failed synchronization", async () => {
    const runtime = new FakeRuntime();
    const secret = "secret-that-must-not-leak";
    runtime.saveSynchronization = "failed";
    runtime.catalogErrors.set("anthropic", new Error(`provider body contained ${secret}`));

    const result = await new PiConfiguration(runtime).saveLiteralToken({
      providerId: "anthropic",
      token: secret,
      confirmReplace: false,
    });

    expect(result).toMatchObject({
      ok: true,
      credentialPersisted: true,
      synchronizationSucceeded: false,
      outcome: "credential-saved/discovery-failed",
      status: {
        catalogStatus: "discovery-failed",
        providers: [{ credential: { source: "stored", storedType: "api_key" } }],
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("sanitizes runtime failures and leaves the prior status visible after failed removal", async () => {
    const runtime = new FakeRuntime();
    const secret = "stored-secret-in-sdk-error";
    runtime.credentials.set("anthropic", { stored: { type: "api_key" } });
    runtime.removeError = new Error(`raw auth.json and ${secret}`);

    const result = await new PiConfiguration(runtime).removeStoredCredential({
      providerId: "anthropic",
      confirmRemove: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "credential-remove-failed", retryable: true },
      status: {
        providers: [{ credential: { source: "stored", storedType: "api_key" } }],
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not expose a submitted token when the credential write fails", async () => {
    const runtime = new FakeRuntime();
    const secret = "submitted-secret-in-sdk-error";
    runtime.models.set("anthropic", [eligibleModel("anthropic", secret)]);
    runtime.saveError = new Error(`raw provider response contained ${secret}`);

    const result = await new PiConfiguration(runtime).saveLiteralToken({
      providerId: "anthropic",
      token: secret,
      confirmReplace: false,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "credential-save-failed", retryable: true },
    });
    expect(runtime.saveCalls).toEqual([{ providerId: "anthropic", token: secret }]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("refreshes discovery without resubmitting a token", async () => {
    const runtime = new FakeRuntime();
    const configuration = new PiConfiguration(runtime);

    const result = await configuration.refresh("anthropic");

    expect(result.ok).toBe(true);
    expect(runtime.refreshCalls).toEqual(["anthropic"]);
    expect(runtime.saveCalls).toEqual([]);
  });

  it("normalizes attributable accounting without raw or secret-bearing fields", () => {
    const secret = "provider-secret-stop-reason";
    const accounting = normalizePiAccounting({
      qualifiedModelId: "anthropic/claude-test",
      usage: {
        input: 12.9,
        output: 4,
        cacheRead: -3,
        cacheWrite: Number.POSITIVE_INFINITY,
        cost: { total: 0.25 },
      },
      stopReason: secret,
    });

    expect(accounting).toEqual({
      provider: "pi",
      model: "anthropic/claude-test",
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      costUsd: 0.25,
      stopReason: undefined,
    });
    expect(JSON.stringify(accounting)).not.toContain(secret);
  });
});
