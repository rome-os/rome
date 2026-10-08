import { describe, expect, it, rs } from "@rstest/core";
import { createAIToolState, type AIToolStateProbes } from "./ai-tool-state.js";

function probes(overrides: Partial<AIToolStateProbes> = {}): AIToolStateProbes {
  return {
    codexStatus: async () => ({ loggedIn: true, authMode: "chatgpt", planType: "plus" }),
    claudeStatus: async () => ({ loggedIn: true }),
    codexUsage: async () => null,
    claudeUsage: async () => null,
    ...overrides,
  };
}

describe("AIToolState", () => {
  it("starts with conservative Sol and Luna access until the plan is known", () => {
    const state = createAIToolState({
      probes: probes(),
      startRefresh: false,
      refreshIntervalMs: null,
    });
    expect(state.get()).toEqual({
      codex: { quotaExhausted: false, solAccess: false, lunaAccess: false },
      claude: { quotaExhausted: false },
    });
  });

  it.each([
    ["free", false],
    ["go", false],
    ["plus", true],
    ["pro", true],
    ["prolite", true],
    ["team", true],
    ["self_serve_business_usage_based", true],
    ["business", true],
    ["enterprise_cbp_usage_based", true],
    ["enterprise", true],
    ["edu", true],
    ["unknown", false],
  ] as const)("derives Sol and Luna access from the %s plan", async (planType, expected) => {
    const state = createAIToolState({
      probes: probes({
        codexStatus: async () => ({ loggedIn: true, authMode: "chatgpt", planType }),
      }),
      startRefresh: false,
      refreshIntervalMs: null,
    });

    await state.refresh("openai");
    expect(state.get().codex).toMatchObject({
      solAccess: expected,
      lunaAccess: expected,
    });
  });

  it("allows Sol and Luna for API-key authentication", async () => {
    const state = createAIToolState({
      probes: probes({
        codexStatus: async () => ({ loggedIn: true, authMode: "apikey" }),
      }),
      startRefresh: false,
      refreshIntervalMs: null,
    });

    await state.refresh("openai");
    expect(state.get().codex).toMatchObject({ solAccess: true, lunaAccess: true });
  });

  it("marks quota immediately and clears it when refreshed usage has capacity", async () => {
    const state = createAIToolState({
      probes: probes({
        codexUsage: async () => ({
          checkedAt: "2026-07-11T00:00:00.000Z",
          source: "test",
          fiveHour: { usedPercent: 50 },
        }),
      }),
      startRefresh: false,
      refreshIntervalMs: null,
    });
    state.markQuotaExhausted("openai");
    expect(state.get().codex.quotaExhausted).toBe(true);
    await state.refresh("openai");
    expect(state.get().codex.quotaExhausted).toBe(false);
  });

  it.each([
    "anthropic",
    "openai",
  ] as const)("replaces stale %s usage on failed probes without clearing a quota signal", async (provider) => {
    const exhausted = {
      checkedAt: "2026-09-27T17:12:35.031Z",
      source: "test",
      sevenDay: { usedPercent: 100, resetsAt: "2026-09-28T04:59:59.955Z" },
    };
    const failed = {
      checkedAt: "2026-09-28T17:00:00.000Z",
      source: "test",
      error: "Claude usage request failed with HTTP 429",
    };
    const usageProbe = rs.fn<AIToolStateProbes["claudeUsage"]>();
    usageProbe.mockResolvedValueOnce(exhausted);
    usageProbe.mockResolvedValueOnce(failed);
    usageProbe.mockResolvedValueOnce(null);
    usageProbe.mockRejectedValueOnce(new Error("usage timed out"));
    usageProbe.mockResolvedValueOnce({ ...failed, sevenDay: exhausted.sevenDay });
    usageProbe.mockResolvedValueOnce({
      checkedAt: "2026-09-28T17:05:00.000Z",
      source: "test",
      sevenDay: { usedPercent: 2, resetsAt: "2026-10-05T04:59:59.955Z" },
    });
    const state = createAIToolState({
      probes: probes({
        [provider === "anthropic" ? "claudeUsage" : "codexUsage"]: usageProbe,
      }),
      startRefresh: false,
      refreshIntervalMs: null,
    });
    const current = () => state.get()[provider === "anthropic" ? "claude" : "codex"];
    try {
      await state.refresh(provider);
      expect(current().usage?.sevenDay?.usedPercent).toBe(100);
      expect(current().quotaExhausted).toBe(true);

      await state.refresh(provider);
      expect(current().usage).toEqual(failed);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await state.refresh(provider);
        expect(current().usage?.error).toBeTruthy();
        expect(current().usage?.sevenDay).toBeUndefined();
        expect(current().quotaExhausted).toBe(true);
      }

      await state.refresh(provider);
      expect(current().usage?.error).toBeUndefined();
      expect(current().usage?.sevenDay?.usedPercent).toBe(2);
      expect(current().quotaExhausted).toBe(false);
    } finally {
      state.close();
    }
  });

  it("does not let an older in-flight refresh clear a runtime quota failure", async () => {
    let releaseUsage!: () => void;
    const usageGate = new Promise<void>((resolve) => {
      releaseUsage = resolve;
    });
    const state = createAIToolState({
      probes: probes({
        codexUsage: async () => {
          await usageGate;
          return {
            checkedAt: "2026-08-07T00:00:00.000Z",
            source: "test",
            fiveHour: { usedPercent: 50 },
          };
        },
      }),
      startRefresh: false,
      refreshIntervalMs: null,
    });

    const refresh = state.refresh("openai");
    state.markQuotaExhausted("openai");
    expect(state.get().codex.quotaExhausted).toBe(true);

    releaseUsage();
    await refresh;

    expect(state.get().codex.quotaExhausted).toBe(true);
  });

  it.each([
    "stored-compatible",
    "environment",
  ] as const)("treats %s API-key auth as available without Claude OAuth usage", async (authMethod) => {
    let currentAuthMethod: "oauth" | typeof authMethod = "oauth";
    const state = createAIToolState({
      probes: probes({
        claudeStatus: async () => ({ loggedIn: true, authMethod: currentAuthMethod }),
        claudeUsage: async () => ({
          checkedAt: "2026-07-11T00:00:00.000Z",
          source: "claude oauth cache",
          fiveHour: { usedPercent: 100 },
        }),
      }),
      startRefresh: false,
      refreshIntervalMs: null,
    });

    await state.refresh("anthropic");
    expect(state.get().claude).toMatchObject({
      authMethod: "oauth",
      quotaExhausted: true,
      usage: { source: "claude oauth cache" },
    });

    currentAuthMethod = authMethod;
    await state.refresh("anthropic");

    expect(state.get().claude).toMatchObject({
      loggedIn: true,
      authMethod,
      quotaExhausted: false,
    });
    expect(state.get().claude.usage).toBeUndefined();

    state.markQuotaExhausted("anthropic");
    expect(state.get().claude.quotaExhausted).toBe(false);
  });

  it("marks revoked auth after an older in-flight status refresh finishes", async () => {
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const state = createAIToolState({
      probes: probes({
        codexStatus: async () => {
          await statusGate;
          return { loggedIn: true, authMode: "chatgpt", planType: "plus" };
        },
      }),
      startRefresh: false,
      refreshIntervalMs: null,
    });

    const refresh = state.refresh("openai");
    const markRevoked = state.markAuthRevoked("openai");
    releaseStatus();
    await Promise.all([refresh, markRevoked]);

    expect(state.get().codex).toMatchObject({
      loggedIn: false,
      needsReauth: true,
      solAccess: false,
      lunaAccess: false,
    });
  });

  it("marks revoked Claude auth without changing quota state", async () => {
    const state = createAIToolState({
      probes: probes(),
      startRefresh: false,
      refreshIntervalMs: null,
    });

    await state.markAuthRevoked("anthropic");

    expect(state.get().claude).toEqual({
      loggedIn: false,
      needsReauth: true,
      quotaExhausted: false,
    });
  });

  it("sets conservative access after a definite logout", async () => {
    const codexUsage = rs.fn(async () => null);
    const state = createAIToolState({
      probes: probes({
        codexStatus: async () => ({ loggedIn: false }),
        codexUsage,
      }),
      startRefresh: false,
      refreshIntervalMs: null,
    });

    await state.refresh("openai");

    expect(state.get().codex.loggedIn).toBe(false);
    expect(state.get().codex).toMatchObject({ solAccess: false, lunaAccess: false });
    expect(codexUsage).toHaveBeenCalledTimes(1);
  });

  it("preserves the last derived access when the login check fails", async () => {
    let failStatus = false;
    const state = createAIToolState({
      probes: probes({
        codexStatus: async () => {
          if (failStatus) throw new Error("status unavailable");
          return { loggedIn: true, authMode: "chatgpt", planType: "plus" };
        },
      }),
      startRefresh: false,
      refreshIntervalMs: null,
    });

    await state.refresh("openai");
    expect(state.get().codex).toMatchObject({ solAccess: true, lunaAccess: true });

    failStatus = true;
    await state.refresh("openai");
    expect(state.get().codex).toMatchObject({ solAccess: true, lunaAccess: true });
  });

  it("coalesces concurrent refreshes for the same provider", async () => {
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const codexStatus = rs.fn(async () => {
      await statusGate;
      return { loggedIn: true };
    });
    const state = createAIToolState({
      probes: probes({ codexStatus }),
      startRefresh: false,
      refreshIntervalMs: null,
    });

    const first = state.refresh("openai");
    const second = state.refresh("openai");
    const full = state.refresh();

    expect(codexStatus).toHaveBeenCalledTimes(1);
    releaseStatus();
    await Promise.all([first, second, full]);
    expect(codexStatus).toHaveBeenCalledTimes(1);

    await state.refresh("openai");
    expect(codexStatus).toHaveBeenCalledTimes(2);
  });

  it("does not let an in-flight provider block a different provider", async () => {
    let releaseClaude!: () => void;
    const claudeGate = new Promise<void>((resolve) => {
      releaseClaude = resolve;
    });
    const claudeStatus = rs.fn(async () => {
      await claudeGate;
      return { loggedIn: true };
    });
    const codexStatus = rs.fn(async () => ({ loggedIn: true }));
    const state = createAIToolState({
      probes: probes({ claudeStatus, codexStatus }),
      startRefresh: false,
      refreshIntervalMs: null,
    });

    const claudeRefresh = state.refresh("anthropic");
    await state.refresh("openai");

    expect(claudeStatus).toHaveBeenCalledTimes(1);
    expect(codexStatus).toHaveBeenCalledTimes(1);
    releaseClaude();
    await claudeRefresh;
  });

  it("preserves startup and hourly probes for both providers without probing cached reads", async () => {
    rs.useFakeTimers();
    const codexStatus = rs.fn(async () => ({ loggedIn: true }));
    const claudeStatus = rs.fn(async () => ({ loggedIn: true }));
    const codexUsage = rs.fn(async () => null);
    const claudeUsage = rs.fn(async () => null);
    const allProbes = { codexStatus, claudeStatus, codexUsage, claudeUsage };
    const state = createAIToolState({ probes: allProbes });
    try {
      for (const probe of Object.values(allProbes)) expect(probe).toHaveBeenCalledTimes(1);
      await state.refresh();
      for (const probe of Object.values(allProbes)) expect(probe).toHaveBeenCalledTimes(1);

      for (let read = 0; read < 20; read += 1) state.get();
      await rs.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
      for (const probe of Object.values(allProbes)) expect(probe).toHaveBeenCalledTimes(1);

      await rs.advanceTimersByTimeAsync(1);
      for (const probe of Object.values(allProbes)) expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      state.close();
      rs.useRealTimers();
    }
  });

  it("runs all provider checks on the hourly timer", async () => {
    rs.useFakeTimers();
    const codexStatus = rs.fn(async () => ({
      loggedIn: true,
      authMode: "chatgpt" as const,
      planType: "plus" as const,
    }));
    const codexUsage = rs.fn(async () => ({
      checkedAt: "2026-07-11T00:00:00.000Z",
      source: "test",
      fiveHour: { usedPercent: 50 },
    }));
    const claudeStatus = rs.fn(async () => ({ loggedIn: true, authMethod: "oauth" }));
    const claudeUsage = rs.fn(async () => ({
      checkedAt: "2026-07-11T00:00:00.000Z",
      source: "test",
      fiveHour: { usedPercent: 50 },
    }));
    const state = createAIToolState({
      probes: probes({ codexStatus, codexUsage, claudeStatus, claudeUsage }),
      startRefresh: false,
      refreshIntervalMs: 1_000,
    });
    state.markQuotaExhausted("openai");
    state.markQuotaExhausted("anthropic");
    await rs.advanceTimersByTimeAsync(1_000);
    expect(codexStatus).toHaveBeenCalledTimes(1);
    expect(codexUsage).toHaveBeenCalledTimes(1);
    expect(claudeStatus).toHaveBeenCalledTimes(1);
    expect(claudeUsage).toHaveBeenCalledTimes(1);
    expect(state.get().codex.quotaExhausted).toBe(false);
    expect(state.get().claude.quotaExhausted).toBe(false);
    state.close();
    rs.useRealTimers();
  });
});
