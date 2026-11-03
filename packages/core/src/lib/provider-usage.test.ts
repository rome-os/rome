import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as osModule from "node:os" with { rstest: "importActual" };
import { join } from "node:path";
import { describe, expect, it, rs } from "@rstest/core";

const logError = rs.hoisted(() => rs.fn());
// The home directory the module under test resolves `~/.claude` against. It
// points nowhere by default so no test reads the real Claude CLI credentials.
const fakeHome = rs.hoisted(() => ({ dir: "/nonexistent/rome-provider-usage-home" }));

rs.mock("node:os", () => ({
  ...osModule,
  homedir: () => fakeHome.dir,
}));

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
        errorType: undefined,
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
    }
  });

  describe("Claude OAuth usage from the CLI credentials file", () => {
    // Runs readClaudeOAuthUsage with `oauth` in `~/.claude/.credentials.json`
    // under a temp home, CLAUDE_CODE_OAUTH_TOKEN unset and fetch answering
    // `response`.
    const readWithCredentials = async (oauth: Record<string, unknown>, response: Response) => {
      const dir = await fs.mkdtemp(join(tmpdir(), "rome-claude-home-"));
      await fs.mkdir(join(dir, ".claude"));
      await fs.writeFile(
        join(dir, ".claude", ".credentials.json"),
        JSON.stringify({ claudeAiOauth: oauth }),
      );
      const originalHome = fakeHome.dir;
      fakeHome.dir = dir;
      const originalFetch = globalThis.fetch;
      const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const fetchMock = rs.fn(async () => response);
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      logError.mockClear();
      try {
        const usage = await readClaudeOAuthUsage();
        return { usage, fetchMock };
      } finally {
        fakeHome.dir = originalHome;
        globalThis.fetch = originalFetch;
        if (originalToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
        await fs.rm(dir, { recursive: true, force: true });
      }
    };
    const unauthorized = () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "Invalid bearer token test-token" },
        }),
        { status: 401 },
      );
    const usagePayload = () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 27, resets_at: "2026-05-20T02:50:01Z" },
          seven_day: { utilization: 42, resets_at: "2026-05-21T09:00:00Z" },
        }),
        { status: 200 },
      );

    it("reports unknown usage without a request once the CLI token has expired", async () => {
      const { usage, fetchMock } = await readWithCredentials(
        { accessToken: "test-token", expiresAt: Date.now() - 60_000 },
        unauthorized(),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(usage).toBeNull();
      expect(logError).not.toHaveBeenCalled();

      // Control: the same file with a later expiresAt is read and sent, so the
      // skip above comes from the expiry and not from a file that went unread.
      const control = await readWithCredentials(
        { accessToken: "test-token", expiresAt: Date.now() + 3_600_000 },
        unauthorized(),
      );
      expect(control.fetchMock).toHaveBeenCalledTimes(1);
    });

    it("treats a token within a minute of expiry as expired", async () => {
      const { usage, fetchMock } = await readWithCredentials(
        { accessToken: "test-token", expiresAt: Date.now() + 30_000 },
        unauthorized(),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(usage).toBeNull();
    });

    it("sends an unexpired token and reads the usage windows", async () => {
      const { usage, fetchMock } = await readWithCredentials(
        { accessToken: "test-token", expiresAt: Date.now() + 3_600_000 },
        usagePayload(),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(usage).toMatchObject({
        source: "claude oauth usage",
        fiveHour: { usedPercent: 27 },
        sevenDay: { usedPercent: 42 },
      });
      expect(usage?.error).toBeUndefined();
    });

    it.each([
      ["a missing expiresAt", {}],
      ["a non-numeric expiresAt", { expiresAt: "soon" }],
      ["an expiresAt in seconds", { expiresAt: Math.floor(Date.now() / 1000) - 60 }],
    ])("sends the request with %s", async (_label, expiry) => {
      const { usage, fetchMock } = await readWithCredentials(
        { accessToken: "test-token", ...expiry },
        usagePayload(),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(usage).toMatchObject({ fiveHour: { usedPercent: 27 } });
    });

    it("logs the error type of a rejected token, not the token or message", async () => {
      const { usage } = await readWithCredentials(
        { accessToken: "test-token", expiresAt: Date.now() + 3_600_000 },
        unauthorized(),
      );
      expect(usage).toMatchObject({ error: "Claude usage request failed with HTTP 401" });
      expect(logError).toHaveBeenCalledWith("Claude usage request failed", {
        status: 401,
        retryAfter: undefined,
        errorType: "authentication_error",
      });
      expect(JSON.stringify(logError.mock.calls)).not.toContain("test-token");
    });

    it.each([
      ["a non-JSON body", "upstream unavailable"],
      ["a free-text error type", JSON.stringify({ error: { type: "Bearer test-token" } })],
    ])("logs no error type for %s", async (_label, body) => {
      await readWithCredentials(
        { accessToken: "test-token", expiresAt: Date.now() + 3_600_000 },
        new Response(body, { status: 401 }),
      );
      expect(logError).toHaveBeenCalledWith("Claude usage request failed", {
        status: 401,
        retryAfter: undefined,
        errorType: undefined,
      });
    });
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
