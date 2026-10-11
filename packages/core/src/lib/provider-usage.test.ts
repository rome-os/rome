import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, rs } from "@rstest/core";

const logError = rs.hoisted(() => rs.fn());

rs.mock("../logger.js", () => ({
  createLogger: () => ({ error: logError, info: rs.fn(), warn: rs.fn(), debug: rs.fn() }),
}));

import {
  normalizeUsageStatus,
  parseUsageText,
  readClaudeOAuthUsage,
  readLiveOrCachedUsage,
} from "./provider-usage.js";

describe("AI tool usage parsing", () => {
  it("normalizes Claude-style usage windows", () => {
    expect(
      normalizeUsageStatus(
        {
          rate_limits: {
            five_hour: { utilization: 42.25, resets_at: "2026-05-20T05:00:00Z" },
            seven_day: { used_percent: 7 },
          },
        },
        "test",
      ),
    ).toMatchObject({
      source: "test",
      fiveHour: {
        usedPercent: 42.3,
        remainingPercent: 57.7,
        resetsAt: "2026-05-20T05:00:00Z",
      },
      sevenDay: {
        usedPercent: 7,
        remainingPercent: 93,
      },
    });
  });

  it("normalizes Claude OAuth usage response windows", () => {
    expect(
      normalizeUsageStatus(
        {
          five_hour: { utilization: 27, resets_at: "2026-05-20T02:50:01.145293+00:00" },
          seven_day: { utilization: 42, resets_at: "2026-05-21T09:00:00.145315+00:00" },
          extra_usage: { utilization: 89.62 },
        },
        "claude oauth usage",
        { utilizationUnit: "percent" },
      ),
    ).toMatchObject({
      source: "claude oauth usage",
      fiveHour: {
        usedPercent: 27,
        remainingPercent: 73,
        resetsAt: "2026-05-20T02:50:01.145293+00:00",
      },
      sevenDay: {
        usedPercent: 42,
        remainingPercent: 58,
        resetsAt: "2026-05-21T09:00:00.145315+00:00",
      },
    });
  });

  it.each([1, 0.5])("keeps Claude OAuth utilization %s in percentage units", (utilization) => {
    expect(
      normalizeUsageStatus(
        {
          five_hour: { utilization },
          seven_day: { utilization },
        },
        "claude oauth usage",
      ),
    ).toMatchObject({
      fiveHour: {
        usedPercent: utilization,
        remainingPercent: 100 - utilization,
      },
      sevenDay: {
        usedPercent: utilization,
        remainingPercent: 100 - utilization,
      },
    });
  });

  it("normalizes Codex-style primary and secondary windows", () => {
    expect(
      normalizeUsageStatus(
        {
          rateLimits: {
            primary: { usedPercent: 4, resetsAt: 1779250972 },
            secondary: { utilization_percent: "15%" },
          },
        },
        "codex",
      ),
    ).toMatchObject({
      fiveHour: {
        usedPercent: 4,
        remainingPercent: 96,
        resetsAt: "2026-05-20T04:22:52.000Z",
      },
      sevenDay: {
        usedPercent: 15,
        remainingPercent: 85,
      },
    });
  });

  it("classifies a duration-tagged seven-day Codex window returned as primary", () => {
    const usage = normalizeUsageStatus(
      {
        rateLimits: {
          primary: {
            usedPercent: 25,
            windowDurationMins: 10_080,
            resetsAt: 1_787_196_936,
          },
          secondary: null,
        },
      },
      "codex",
    );

    expect(usage).toMatchObject({
      sevenDay: {
        usedPercent: 25,
        remainingPercent: 75,
        resetsAt: "2026-08-20T03:35:36.000Z",
      },
    });
    expect(usage?.fiveHour).toBeUndefined();
  });

  it("classifies a duration-tagged five-hour Codex window returned as primary", () => {
    const usage = normalizeUsageStatus(
      {
        rateLimits: {
          primary: { usedPercent: 40, windowDurationMins: 300 },
          secondary: null,
        },
      },
      "codex",
    );

    expect(usage).toMatchObject({
      fiveHour: { usedPercent: 40, remainingPercent: 60 },
    });
    expect(usage?.sevenDay).toBeUndefined();
  });

  it("does not scale explicit low percentage fields as fractions", () => {
    expect(
      normalizeUsageStatus(
        {
          rateLimits: {
            primary: { usedPercent: 0.5 },
            secondary: { remainingPercent: 1 },
          },
        },
        "codex",
      ),
    ).toMatchObject({
      fiveHour: {
        usedPercent: 0.5,
        remainingPercent: 99.5,
      },
      sevenDay: {
        usedPercent: 99,
        remainingPercent: 1,
      },
    });
  });

  it("still scales ambiguous utilization fractions", () => {
    expect(
      normalizeUsageStatus(
        {
          rateLimits: {
            primary: { utilization: 0.5 },
          },
        },
        "codex",
        { utilizationUnit: "fraction" },
      ),
    ).toMatchObject({
      fiveHour: {
        usedPercent: 50,
        remainingPercent: 50,
      },
    });
  });

  it("parses statusline text that reports remaining percentages", () => {
    expect(parseUsageText("Rate Limits Remaining: 5h 96%, Weekly 94%", "line")).toMatchObject({
      fiveHour: {
        usedPercent: 4,
        remainingPercent: 96,
      },
      sevenDay: {
        usedPercent: 6,
        remainingPercent: 94,
      },
    });
  });

  it("falls back to cached usage when the live probe returns only an error", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "rome-usage-cache-"));
    const cachePath = join(dir, "usage-limits.json");
    try {
      await fs.writeFile(
        cachePath,
        JSON.stringify({
          rateLimits: {
            primary: { usedPercent: 12 },
          },
        }),
      );

      await expect(
        readLiveOrCachedUsage(
          async () => ({
            checkedAt: "2026-05-20T00:00:00.000Z",
            source: "live",
            error: "live probe failed",
          }),
          [cachePath],
        ),
      ).resolves.toMatchObject({
        source: cachePath,
        fiveHour: {
          usedPercent: 12,
          remainingPercent: 88,
        },
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to cached usage when the live probe rejects", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "rome-usage-cache-"));
    const cachePath = join(dir, "usage-limits.json");
    try {
      await fs.writeFile(
        cachePath,
        JSON.stringify({
          rateLimits: {
            primary: { usedPercent: 31 },
          },
        }),
      );

      await expect(
        readLiveOrCachedUsage(async () => {
          throw new Error("usage query failed");
        }, [cachePath]),
      ).resolves.toMatchObject({
        source: cachePath,
        fiveHour: {
          usedPercent: 31,
          remainingPercent: 69,
        },
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the live error when no cached usage is available", async () => {
    await expect(
      readLiveOrCachedUsage(
        async () => ({
          checkedAt: "2026-05-20T00:00:00.000Z",
          source: "live",
          error: "live probe failed",
        }),
        [join(tmpdir(), "missing-rome-usage-cache.json")],
      ),
    ).resolves.toMatchObject({
      source: "live",
      error: "live probe failed",
    });
  });

  it("logs a failed Claude usage request with its status and Retry-After", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "secret-token";
    globalThis.fetch = rs.fn(
      async () => new Response("{}", { status: 429, headers: { "Retry-After": "3600" } }),
    ) as unknown as typeof fetch;
    try {
      await expect(readClaudeOAuthUsage()).resolves.toMatchObject({
        error: "Claude usage request failed with HTTP 429",
      });
      expect(logError).toHaveBeenCalledWith("Claude usage request failed", {
        status: 429,
        retryAfter: "3600",
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
    }
  });

  describe("Claude OAuth usage with no reported windows", () => {
    const respondWith = async (payload: unknown) => {
      const originalFetch = globalThis.fetch;
      const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "secret-token";
      globalThis.fetch = rs.fn(
        async () => new Response(JSON.stringify(payload), { status: 200 }),
      ) as unknown as typeof fetch;
      try {
        return await readClaudeOAuthUsage();
      } finally {
        globalThis.fetch = originalFetch;
        if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
      }
    };

    it.each([
      ["null windows", { five_hour: null, seven_day: null, extra_usage: null }],
      [
        "windows with null utilization",
        {
          five_hour: { utilization: null, resets_at: null },
          seven_day: { utilization: null, resets_at: null },
        },
      ],
    ])("treats %s as a successful empty snapshot", async (_label, payload) => {
      const usage = await respondWith(payload);
      expect(usage).toMatchObject({ source: "claude oauth usage" });
      expect(usage?.error).toBeUndefined();
      expect(usage?.fiveHour).toBeUndefined();
      expect(usage?.sevenDay).toBeUndefined();
    });

    it.each([
      ["an empty object", {}],
      ["unrecognized windows", { five_hour: { foo: 1 }, seven_day: null }],
    ])("reports %s as an unrecognized payload", async (_label, payload) => {
      await expect(respondWith(payload)).resolves.toMatchObject({
        error: "Claude usage response did not include usage windows",
      });
    });
  });
});
