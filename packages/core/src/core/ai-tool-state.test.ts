import { describe, expect, it, rs } from "@rstest/core";
import { createAIToolState, type AIToolStateProbes } from "./ai-tool-state.js";
import type { AIToolUsageStatus } from "../lib/provider-usage.js";

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
      sevenDay: { usedPercent: 100, resetsAt: "2099-01-01T04:59:59.955Z" },
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
      sevenDay: { usedPercent: 2, resetsAt: "2099-01-08T04:59:59.955Z" },
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
      expect(current().quotaExhausted).toBe(true);

      // No usage source is not a failure: no bars and no error.
      await state.refresh(provider);
      expect(current().usage).toBeUndefined();
      expect(current().quotaExhausted).toBe(true);

      await state.refresh(provider);
      expect(current().usage?.error).toBe("usage timed out");
      expect(current().quotaExhausted).toBe(true);

      await state.refresh(provider);
      expect(current().usage).toEqual(failed);
      expect(current().quotaExhausted).toBe(true);

      await state.refresh(provider);
      expect(current().usage?.error).toBeUndefined();
      expect(current().usage?.sevenDay?.usedPercent).toBe(2);
      expect(current().quotaExhausted).toBe(false);
    } finally {
      state.close();
    }
  });

  it("notifies only when the Codex login changes", async () => {
    let loggedIn = true;
    const onCodexLoginChanged = rs.fn();
    const state = createAIToolState({
      probes: probes({ codexStatus: async () => ({ loggedIn }) }),
      onCodexLoginChanged,
      startRefresh: false,
      refreshIntervalMs: null,
    });

    state.markQuotaExhausted("openai");
    expect(onCodexLoginChanged).not.toHaveBeenCalled();

    await state.refresh("openai");
    expect(onCodexLoginChanged).toHaveBeenCalledTimes(1);

    state.markQuotaExhausted("openai");
    await state.refresh("openai");
    expect(onCodexLoginChanged).toHaveBeenCalledTimes(1);

    loggedIn = false;
    await state.refresh("openai");
    expect(onCodexLoginChanged).toHaveBeenCalledTimes(2);
  });

  it("notifies after every Codex refresh, including a failed probe", async () => {
    let fail = false;
    const onCodexRefreshed = rs.fn();
    const state = createAIToolState({
      probes: probes({
        codexStatus: async () => {
          if (fail) throw new Error("down");
          return { loggedIn: true };
        },
      }),
      onCodexRefreshed,
      startRefresh: false,
      refreshIntervalMs: null,
    });

    await state.refresh("anthropic");
    expect(onCodexRefreshed).not.toHaveBeenCalled();
    await state.refresh("openai");
    fail = true;
    await state.refresh();
    expect(onCodexRefreshed).toHaveBeenCalledTimes(2);
  });

  it("notifies a Codex login change before unrelated full-refresh probes settle", async () => {
    let releaseClaude!: () => void;
    const claudeGate = new Promise<void>((resolve) => {
      releaseClaude = resolve;
    });
    const onCodexLoginChanged = rs.fn();
    const state = createAIToolState({
      probes: probes({
        codexStatus: async () => ({ loggedIn: false }),
        claudeStatus: async () => {
          await claudeGate;
          return { loggedIn: true };
        },
      }),
      onCodexLoginChanged,
      startRefresh: false,
      refreshIntervalMs: null,
    });

    const refresh = state.refresh();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.get().codex.loggedIn).toBe(false);
      expect(onCodexLoginChanged).toHaveBeenCalledTimes(1);
    } finally {
      releaseClaude();
      await refresh;
    }
  });

  it("notifies a Codex login change while the quota probe is still pending", async () => {
    let releaseUsage!: () => void;
    const usageGate = new Promise<void>((resolve) => {
      releaseUsage = resolve;
    });
    const onCodexLoginChanged = rs.fn();
    const state = createAIToolState({
      probes: probes({
        codexStatus: async () => ({ loggedIn: false }),
        codexUsage: async () => {
          await usageGate;
          return null;
        },
      }),
      onCodexLoginChanged,
      startRefresh: false,
      refreshIntervalMs: null,
    });

    const refresh = state.refresh("openai");
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.get().codex.loggedIn).toBe(false);
      expect(onCodexLoginChanged).toHaveBeenCalledTimes(1);
    } finally {
      releaseUsage();
      await refresh;
    }
  });

  it("reads Codex usage again after a login change restarts Codex", async () => {
    let loggedIn = false;
    let usedPercent = 100;
    let staleProbe: { reject: (err: Error) => void } | undefined;
    let usageCalls = 0;
    const state = createAIToolState({
      probes: probes({
        codexStatus: async () => ({ loggedIn, authMode: "chatgpt", planType: "plus" }),
        codexUsage: async () => {
          usageCalls += 1;
          if (loggedIn && !staleProbe) {
            // Started on the process that the payer change replaces.
            return await new Promise((_, reject) => {
              staleProbe = { reject };
            });
          }
          return {
            checkedAt: "2026-08-07T00:00:00.000Z",
            source: "test",
            fiveHour: { usedPercent },
          };
        },
      }),
      onCodexLoginChanged: () => staleProbe?.reject(new Error("codex app-server exited")),
      startRefresh: false,
      refreshIntervalMs: null,
    });
    await state.refresh("openai");
    expect(state.get().codex.quotaExhausted).toBe(true);

    loggedIn = true;
    usedPercent = 10;
    const callsBefore = usageCalls;
    await state.refresh("openai");

    expect(usageCalls - callsBefore).toBe(2);
    expect(state.get().codex.quotaExhausted).toBe(false);
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

  describe("usage-derived quota exhaustion", () => {
    const now = Date.parse("2026-10-11T12:00:00.000Z");
    const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
    const HOUR = 60 * 60 * 1000;

    function exhaustedState(windows: Pick<AIToolUsageStatus, "fiveHour" | "sevenDay">) {
      const claudeUsage = rs.fn<AIToolStateProbes["claudeUsage"]>(async () => ({
        checkedAt: at(0),
        source: "test",
        ...windows,
      }));
      const state = createAIToolState({
        probes: probes({ claudeUsage }),
        startRefresh: false,
        refreshIntervalMs: null,
      });
      return { state, claudeUsage };
    }

    it("ends at the latest reset among the exhausted windows", async () => {
      rs.useFakeTimers({ shouldAdvanceTime: false });
      rs.setSystemTime(now);
      try {
        const { state, claudeUsage } = exhaustedState({
          fiveHour: { usedPercent: 100, resetsAt: at(HOUR) },
          sevenDay: { usedPercent: 100, resetsAt: at(3 * HOUR) },
        });
        await state.refresh("anthropic");
        expect(state.get().claude.quotaExhausted).toBe(true);

        rs.setSystemTime(now + HOUR);
        expect(state.get().claude.quotaExhausted).toBe(true);

        rs.setSystemTime(now + 3 * HOUR - 1);
        expect(state.get().claude.quotaExhausted).toBe(true);

        rs.setSystemTime(now + 3 * HOUR);
        expect(state.get().claude.quotaExhausted).toBe(false);
        expect(claudeUsage).toHaveBeenCalledTimes(1);
      } finally {
        rs.useRealTimers();
      }
    });

    it("ignores the reset of a window with capacity", async () => {
      rs.useFakeTimers({ shouldAdvanceTime: false });
      rs.setSystemTime(now);
      try {
        const { state } = exhaustedState({
          fiveHour: { usedPercent: 100, resetsAt: at(HOUR) },
          sevenDay: { usedPercent: 40, resetsAt: at(72 * HOUR) },
        });
        await state.refresh("anthropic");
        expect(state.get().claude.quotaExhausted).toBe(true);

        rs.setSystemTime(now + HOUR);
        expect(state.get().claude.quotaExhausted).toBe(false);
      } finally {
        rs.useRealTimers();
      }
    });

    it.each([
      ["no reset time", { fiveHour: { usedPercent: 100 } }],
      ["an unparseable reset time", { fiveHour: { usedPercent: 100, resetsAt: "soon" } }],
      [
        "one exhausted window without a reset time",
        {
          fiveHour: { usedPercent: 100, resetsAt: at(HOUR) },
          sevenDay: { remainingPercent: 0 },
        },
      ],
    ])("blocks for one window after the window has %s, and longer while probes confirm it", async (_case, windows) => {
      rs.useFakeTimers({ shouldAdvanceTime: false });
      rs.setSystemTime(now);
      try {
        const { state, claudeUsage } = exhaustedState(windows);
        await state.refresh("anthropic");
        expect(state.get().claude.quotaExhausted).toBe(true);

        // A later probe that confirms the exhaustion pushes the end out.
        rs.setSystemTime(now + 4 * HOUR);
        await state.refresh("anthropic");
        rs.setSystemTime(now + 9 * HOUR - 1);
        expect(state.get().claude.quotaExhausted).toBe(true);

        // A probe with unknown usage, such as an expired CLI token, does not.
        claudeUsage.mockResolvedValueOnce(null);
        await state.refresh("anthropic");
        rs.setSystemTime(now + 9 * HOUR);
        expect(state.get().claude.quotaExhausted).toBe(false);
      } finally {
        rs.useRealTimers();
      }
    });

    it("ends at the usage reset after a runtime quota failure before it", async () => {
      rs.useFakeTimers({ shouldAdvanceTime: false });
      rs.setSystemTime(now);
      try {
        const { state } = exhaustedState({
          fiveHour: { usedPercent: 100, resetsAt: at(HOUR) },
        });
        await state.refresh("anthropic");
        rs.setSystemTime(now + HOUR - 1);
        state.markQuotaExhausted("anthropic");
        expect(state.get().claude.quotaExhausted).toBe(true);

        rs.setSystemTime(now + HOUR);
        expect(state.get().claude.quotaExhausted).toBe(false);
      } finally {
        rs.useRealTimers();
      }
    });

    it("judges a replayed runtime quota failure by when it happened", async () => {
      rs.useFakeTimers({ shouldAdvanceTime: false });
      rs.setSystemTime(now);
      try {
        const { state, claudeUsage } = exhaustedState({
          fiveHour: { usedPercent: 100, resetsAt: at(HOUR) },
        });
        await state.refresh("anthropic");
        let releaseUsage!: () => void;
        claudeUsage.mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            releaseUsage = resolve;
          });
          return { checkedAt: at(HOUR), source: "test", error: "HTTP 429" };
        });
        const olderRefresh = state.refresh("anthropic");
        rs.setSystemTime(now + HOUR - 1);
        state.markQuotaExhausted("anthropic");

        rs.setSystemTime(now + HOUR);
        releaseUsage();
        await olderRefresh;
        expect(state.get().claude.quotaExhausted).toBe(false);
      } finally {
        rs.useRealTimers();
      }
    });

    it("keeps the reset known at a runtime quota failure when an older probe shows capacity", async () => {
      rs.useFakeTimers({ shouldAdvanceTime: false });
      rs.setSystemTime(now);
      try {
        const { state, claudeUsage } = exhaustedState({
          fiveHour: { usedPercent: 100, resetsAt: at(HOUR) },
        });
        await state.refresh("anthropic");
        let releaseUsage!: () => void;
        claudeUsage.mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            releaseUsage = resolve;
          });
          return { checkedAt: at(0), source: "test", fiveHour: { usedPercent: 0 } };
        });
        const olderRefresh = state.refresh("anthropic");
        state.markQuotaExhausted("anthropic");
        releaseUsage();
        await olderRefresh;
        expect(state.get().claude.quotaExhausted).toBe(true);

        rs.setSystemTime(now + HOUR);
        expect(state.get().claude.quotaExhausted).toBe(false);
      } finally {
        rs.useRealTimers();
      }
    });

    it("caps a replayed failure over an exhausted window with no reset at one window", async () => {
      rs.useFakeTimers({ shouldAdvanceTime: false });
      rs.setSystemTime(now);
      try {
        const { state, claudeUsage } = exhaustedState({
          fiveHour: { usedPercent: 100, resetsAt: at(HOUR) },
        });
        await state.refresh("anthropic");
        let releaseUsage!: () => void;
        claudeUsage.mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            releaseUsage = resolve;
          });
          return {
            checkedAt: at(0),
            source: "test",
            fiveHour: { usedPercent: 100, resetsAt: at(HOUR) },
            sevenDay: { usedPercent: 100 },
          };
        });
        const olderRefresh = state.refresh("anthropic");
        state.markQuotaExhausted("anthropic");
        releaseUsage();
        await olderRefresh;

        rs.setSystemTime(now + 5 * HOUR - 1);
        expect(state.get().claude.quotaExhausted).toBe(true);

        rs.setSystemTime(now + 5 * HOUR);
        expect(state.get().claude.quotaExhausted).toBe(false);
      } finally {
        rs.useRealTimers();
      }
    });

    it("lets a runtime quota failure after the usage reset outlast it for one window", async () => {
      rs.useFakeTimers({ shouldAdvanceTime: false });
      rs.setSystemTime(now);
      try {
        const { state } = exhaustedState({
          fiveHour: { usedPercent: 100, resetsAt: at(HOUR) },
        });
        await state.refresh("anthropic");
        rs.setSystemTime(now + HOUR);
        state.markQuotaExhausted("anthropic");

        rs.setSystemTime(now + 6 * HOUR - 1);
        expect(state.get().claude.quotaExhausted).toBe(true);

        rs.setSystemTime(now + 6 * HOUR);
        expect(state.get().claude.quotaExhausted).toBe(false);
      } finally {
        rs.useRealTimers();
      }
    });

    it("ends a runtime quota failure with no reset after one window while probes fail", async () => {
      rs.useFakeTimers({ shouldAdvanceTime: false });
      rs.setSystemTime(now);
      try {
        // An expired CLI token: every probe reports unknown usage.
        const claudeUsage = rs.fn<AIToolStateProbes["claudeUsage"]>(async () => null);
        const state = createAIToolState({
          probes: probes({ claudeUsage }),
          startRefresh: false,
          refreshIntervalMs: null,
        });
        state.markQuotaExhausted("anthropic");

        rs.setSystemTime(now + 5 * HOUR - 1);
        await state.refresh("anthropic");
        expect(state.get().claude.quotaExhausted).toBe(true);

        rs.setSystemTime(now + 5 * HOUR);
        expect(state.get().claude.quotaExhausted).toBe(false);
      } finally {
        rs.useRealTimers();
      }
    });

    it("keeps a usage reset when a later probe fails", async () => {
      rs.useFakeTimers({ shouldAdvanceTime: false });
      rs.setSystemTime(now);
      try {
        const { state, claudeUsage } = exhaustedState({
          fiveHour: { usedPercent: 100, resetsAt: at(HOUR) },
        });
        await state.refresh("anthropic");
        claudeUsage.mockResolvedValueOnce({
          checkedAt: at(0),
          source: "test",
          error: "Claude usage request failed with HTTP 429",
        });
        await state.refresh("anthropic");
        expect(state.get().claude.quotaExhausted).toBe(true);

        rs.setSystemTime(now + HOUR);
        expect(state.get().claude.quotaExhausted).toBe(false);
      } finally {
        rs.useRealTimers();
      }
    });
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
