import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect, rs } from "@rstest/core";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { normalizeUsageStatus, parseUsageText, readLiveOrCachedUsage } from "./ai-tools.js";
import { aiToolsRoutes } from "./ai-tools.js";
import { createTestDb, buildTestDeps, type TestDb } from "../../test/helpers.js";
import { ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING } from "../../lib/anthropic-compatible-providers.js";
import { settings } from "../../db/schema.js";
import * as anthropicLoginModule from "../../lib/anthropic-login.js" with {
  rstest: "importActual",
};

const {
  isAnthropicAuthRevokedMock,
  isAnthropicCompatibleAuthRevokedMock,
  clearClaudeAuthRevokedMock,
  clearStoredAnthropicCompatibleAuthRevokedMock,
  closeAuthTabsMock,
  openServerBrowserTabMock,
} = rs.hoisted(() => ({
  isAnthropicAuthRevokedMock: rs.fn(),
  isAnthropicCompatibleAuthRevokedMock: rs.fn(),
  clearClaudeAuthRevokedMock: rs.fn(),
  clearStoredAnthropicCompatibleAuthRevokedMock: rs.fn(),
  closeAuthTabsMock: rs.fn(),
  openServerBrowserTabMock: rs.fn(),
}));

rs.mock("./desktop.js", () => ({
  closeAuthTabs: closeAuthTabsMock,
  openServerBrowserTab: openServerBrowserTabMock,
}));

rs.mock("../../lib/anthropic-login.js", () => ({
  ...anthropicLoginModule,
  clearClaudeAuthRevoked: clearClaudeAuthRevokedMock,
  clearStoredAnthropicCompatibleAuthRevoked: clearStoredAnthropicCompatibleAuthRevokedMock,
  isAnthropicAuthRevoked: isAnthropicAuthRevokedMock,
  isAnthropicCompatibleAuthRevoked: isAnthropicCompatibleAuthRevokedMock,
}));

beforeEach(() => {
  isAnthropicAuthRevokedMock.mockReset();
  isAnthropicCompatibleAuthRevokedMock.mockReset();
  clearClaudeAuthRevokedMock.mockReset();
  clearStoredAnthropicCompatibleAuthRevokedMock.mockReset();
  closeAuthTabsMock.mockReset();
  openServerBrowserTabMock.mockReset();
  isAnthropicAuthRevokedMock.mockResolvedValue(false);
  isAnthropicCompatibleAuthRevokedMock.mockResolvedValue(false);
  clearClaudeAuthRevokedMock.mockResolvedValue(undefined);
  clearStoredAnthropicCompatibleAuthRevokedMock.mockResolvedValue(undefined);
  closeAuthTabsMock.mockResolvedValue(0);
  openServerBrowserTabMock.mockResolvedValue({ ok: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

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
});

describe("AI tools status API", () => {
  it("refreshes the process state through the explicit refresh endpoint", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      const refreshed = {
        codex: {
          loggedIn: true,
          quotaExhausted: false,
          solAccess: true,
          lunaAccess: false,
        },
        claude: { loggedIn: false, quotaExhausted: false },
      };
      const refresh = rs.spyOn(deps.aiToolState, "refresh").mockResolvedValue(refreshed);
      const app = new Hono().route("/", aiToolsRoutes(deps));

      const res = await app.request("/ai-tools/refresh", { method: "POST" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(refreshed);
      expect(refresh).toHaveBeenCalledWith();
    } finally {
      testDb.close();
    }
  });

  it("does not run the Codex app-server usage probe from the status endpoint", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "rome-ai-tools-bin-"));
    const logPath = join(dir, "codex-args.log");
    const originalPath = process.env.PATH;
    const originalCodexBin = process.env.ROME_CODEX_BIN;
    const originalClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const testDb = createTestDb();

    try {
      await fs.writeFile(
        join(dir, "claude"),
        ["#!/bin/sh", 'printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"oauth"}\''].join("\n"),
        { mode: 0o755 },
      );
      await fs.writeFile(
        join(dir, "codex"),
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> '${logPath}'`,
          'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
          "  printf '%s\\n' 'Logged in using ChatGPT account'",
          "  exit 0",
          "fi",
          'if [ "$1" = "app-server" ]; then',
          "  printf '%s\\n' 'unexpected app-server usage probe' >&2",
          "  exit 42",
          "fi",
          "exit 1",
        ].join("\n"),
        { mode: 0o755 },
      );

      process.env.PATH = `${dir}:${originalPath ?? ""}`;
      process.env.ROME_CODEX_BIN = join(dir, "codex");
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

      const deps = await buildTestDeps(testDb.db);
      await deps.aiToolState.refresh();
      await fs.writeFile(logPath, "");
      const app = new Hono().route("/", aiToolsRoutes(deps));
      const res = await app.request("/ai-tools/status");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        claude: { loggedIn: true },
        codex: { loggedIn: true },
      });
      await expect(fs.readFile(logPath, "utf8")).resolves.not.toContain("app-server");
    } finally {
      testDb.close();
      process.env.PATH = originalPath;
      if (originalCodexBin === undefined) {
        delete process.env.ROME_CODEX_BIN;
      } else {
        process.env.ROME_CODEX_BIN = originalCodexBin;
      }
      if (originalClaudeToken === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeToken;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("downgrades Claude status to needsReauth when a request-time revoked marker is present", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "rome-ai-tools-bin-"));
    const originalPath = process.env.PATH;
    const originalCodexBin = process.env.ROME_CODEX_BIN;
    const originalClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const testDb = createTestDb();
    isAnthropicAuthRevokedMock.mockResolvedValue(true);

    try {
      await fs.writeFile(
        join(dir, "claude"),
        ["#!/bin/sh", 'printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"oauth"}\''].join("\n"),
        { mode: 0o755 },
      );
      await fs.writeFile(
        join(dir, "codex"),
        [
          "#!/bin/sh",
          'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
          "  printf '%s\\n' 'Logged in using ChatGPT account'",
          "  exit 0",
          "fi",
          "exit 1",
        ].join("\n"),
        { mode: 0o755 },
      );

      process.env.PATH = `${dir}:${originalPath ?? ""}`;
      process.env.ROME_CODEX_BIN = join(dir, "codex");
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

      const deps = await buildTestDeps(testDb.db);
      await deps.aiToolState.refresh();
      const app = new Hono().route("/", aiToolsRoutes(deps));
      const res = await app.request("/ai-tools/status");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        claude: { loggedIn: false, needsReauth: true, authMethod: "oauth" },
        codex: { loggedIn: true },
      });
    } finally {
      testDb.close();
      process.env.PATH = originalPath;
      if (originalCodexBin === undefined) {
        delete process.env.ROME_CODEX_BIN;
      } else {
        process.env.ROME_CODEX_BIN = originalCodexBin;
      }
      if (originalClaudeToken === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeToken;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("marks Claude unavailable when stored Anthropic-compatible credentials are revoked", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "rome-ai-tools-bin-"));
    const originalPath = process.env.PATH;
    const originalCodexBin = process.env.ROME_CODEX_BIN;
    const testDb = createTestDb();
    isAnthropicCompatibleAuthRevokedMock.mockResolvedValue(true);

    try {
      await fs.writeFile(
        join(dir, "claude"),
        ["#!/bin/sh", 'printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"oauth"}\''].join("\n"),
        { mode: 0o755 },
      );
      await fs.writeFile(
        join(dir, "codex"),
        [
          "#!/bin/sh",
          'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
          "  printf '%s\\n' 'Logged in using ChatGPT account'",
          "  exit 0",
          "fi",
          "exit 1",
        ].join("\n"),
        { mode: 0o755 },
      );
      await testDb.db.insert(settings).values({
        key: ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING,
        value: {
          provider: "deepseek",
          apiKey: "deepseek-key",
          updatedAt: "2026-04-26T00:00:00.000Z",
        },
        updatedAt: new Date("2026-04-26T00:00:00.000Z"),
      });

      process.env.PATH = `${dir}:${originalPath ?? ""}`;
      process.env.ROME_CODEX_BIN = join(dir, "codex");

      const deps = await buildTestDeps(testDb.db);
      await deps.aiToolState.refresh();
      const app = new Hono().route("/", aiToolsRoutes(deps));
      const res = await app.request("/ai-tools/status");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        claude: { loggedIn: false, needsReauth: true, authMethod: "stored-compatible" },
        anthropicCompatible: {
          provider: "deepseek",
          providerName: "DeepSeek",
          hasApiKey: true,
          needsReauth: true,
        },
      });
      expect(isAnthropicAuthRevokedMock).not.toHaveBeenCalled();
    } finally {
      testDb.close();
      process.env.PATH = originalPath;
      if (originalCodexBin === undefined) {
        delete process.env.ROME_CODEX_BIN;
      } else {
        process.env.ROME_CODEX_BIN = originalCodexBin;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex device-code login API", () => {
  it("delegates start, status, and cancel to the shared account service", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      const startDeviceLogin = rs.spyOn(deps.codexAccountService, "startDeviceLogin");
      const cancelLogin = rs.spyOn(deps.codexAccountService, "cancelLogin");
      rs.spyOn(deps.codexAccountService, "getLoginState").mockReturnValue({
        running: true,
        mode: "device",
        userCode: "TEST-CODE",
        verificationUrl: "https://auth.openai.com/codex/device",
        lastError: null,
      });
      const app = new Hono().route("/", aiToolsRoutes(deps));

      const start = await app.request("/ai-tools/codex/device-login/start", { method: "POST" });
      expect(start.status).toBe(200);
      expect(await start.json()).toMatchObject({
        userCode: "TEST-CODE",
        verificationUrl: "https://auth.openai.com/codex/device",
      });
      expect(startDeviceLogin).toHaveBeenCalledTimes(1);

      const status = await app.request("/ai-tools/status");
      expect(status.status).toBe(200);
      const statusBody = (await status.json()) as {
        codexDeviceLogin?: { running?: boolean; userCode?: string | null };
      };
      expect(statusBody.codexDeviceLogin?.userCode).toBe("TEST-CODE");
      expect(statusBody.codexDeviceLogin?.running).toBe(true);

      const cancel = await app.request("/ai-tools/codex/device-login/cancel", { method: "POST" });
      expect(cancel.status).toBe(200);
      expect(await cancel.json()).toEqual({ ok: true });
      expect(cancelLogin).toHaveBeenCalledTimes(1);
    } finally {
      testDb.close();
    }
  });
});

describe("Codex shared account routes", () => {
  it("exposes asynchronous browser-login failures through the browser status", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      rs.spyOn(deps.codexAccountService, "getLoginState").mockReturnValue({
        running: false,
        mode: null,
        userCode: null,
        verificationUrl: null,
        lastError: "authorization declined",
      });
      const app = new Hono().route("/", aiToolsRoutes(deps));

      const response = await app.request("/ai-tools/status");

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        codexLogin: {
          running: false,
          lastError: "authorization declined",
        },
      });
    } finally {
      testDb.close();
    }
  });

  it("starts browser login through the account service and opens its auth URL", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      const startBrowserLogin = rs.spyOn(deps.codexAccountService, "startBrowserLogin");
      const app = new Hono().route("/", aiToolsRoutes(deps));

      const response = await app.request("/ai-tools/codex/login/start", { method: "POST" });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ started: true });
      expect(closeAuthTabsMock).toHaveBeenCalledTimes(1);
      expect(startBrowserLogin).toHaveBeenCalledTimes(1);
      expect(openServerBrowserTabMock).toHaveBeenCalledWith("https://auth.openai.com/test");
    } finally {
      testDb.close();
    }
  });

  it("logs out through the account service before refreshing OpenAI state", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      const logout = rs.spyOn(deps.codexAccountService, "logout");
      const refresh = rs
        .spyOn(deps.aiToolState, "refresh")
        .mockResolvedValue(deps.aiToolState.get());
      const app = new Hono().route("/", aiToolsRoutes(deps));

      const response = await app.request("/ai-tools/codex/logout", { method: "POST" });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(logout).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith("openai");
    } finally {
      testDb.close();
    }
  });
});

describe("AI tools Anthropic-compatible credentials API", () => {
  let testDb: TestDb;
  let deps: Awaited<ReturnType<typeof buildTestDeps>>;
  let app: Hono;

  beforeEach(async () => {
    testDb = createTestDb();
    deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", aiToolsRoutes(deps));
  });

  afterEach(() => testDb.close());

  it("lists supported providers and returns no configured provider initially", async () => {
    const res = await app.request("/ai-tools/anthropic-compatible-providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.configured).toBeNull();
    expect(body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "minimax", apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN" }),
        expect.objectContaining({ id: "minimax-intl", apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN" }),
        expect.objectContaining({ id: "z-ai", apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN" }),
        expect.objectContaining({ id: "kimi", apiKeyEnvVar: "ANTHROPIC_API_KEY" }),
        expect.objectContaining({ id: "deepseek", apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN" }),
        expect.objectContaining({ id: "meta", apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN" }),
        expect.objectContaining({ id: "custom", kind: "custom" }),
      ]),
    );
  });

  it("stores only a redacted configured summary in API responses", async () => {
    const save = await app.request("/ai-tools/anthropic-compatible-credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "kimi", apiKey: " kimi-key " }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({
      ok: true,
      configured: {
        provider: "kimi",
        providerName: "Kimi",
        hasApiKey: true,
      },
    });

    const [stored] = await testDb.db
      .select()
      .from(settings)
      .where(eq(settings.key, ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING));
    expect(stored?.value).toMatchObject({ provider: "kimi", apiKey: "kimi-key" });
    expect(clearStoredAnthropicCompatibleAuthRevokedMock).toHaveBeenCalledTimes(1);

    const providers = await app.request("/ai-tools/anthropic-compatible-providers");
    const providersBody = await providers.json();
    expect(providersBody.configured).toMatchObject({
      provider: "kimi",
      providerName: "Kimi",
      hasApiKey: true,
    });
    expect(JSON.stringify(providersBody)).not.toContain("kimi-key");
  });

  it("stores and returns the complete custom environment", async () => {
    const save = await app.request("/ai-tools/anthropic-compatible-credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "custom",
        env: {
          ANTHROPIC_AUTH_TOKEN: "ark-key",
          ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan",
          ANTHROPIC_MODEL: "ep-one",
        },
      }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({
      configured: {
        provider: "custom",
        env: {
          ANTHROPIC_AUTH_TOKEN: "ark-key",
          ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan",
          ANTHROPIC_MODEL: "ep-one",
        },
      },
    });

    const configured = await app.request("/ai-tools/anthropic-compatible-providers");
    const configuredBody = await configured.json();
    expect(configuredBody.configured.env.ANTHROPIC_AUTH_TOKEN).toBe("ark-key");

    const update = await app.request("/ai-tools/anthropic-compatible-credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "custom",
        env: {
          ANTHROPIC_AUTH_TOKEN: "ark-key",
          ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan",
          ANTHROPIC_MODEL: "ep-two",
        },
      }),
    });
    expect(update.status).toBe(200);

    const [stored] = await testDb.db
      .select()
      .from(settings)
      .where(eq(settings.key, ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING));
    expect(stored?.value).toMatchObject({
      provider: "custom",
      env: {
        ANTHROPIC_AUTH_TOKEN: "ark-key",
        ANTHROPIC_MODEL: "ep-two",
      },
    });
  });

  it("rejects unsafe custom environment variables", async () => {
    const response = await app.request("/ai-tools/anthropic-compatible-credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "custom",
        env: {
          ANTHROPIC_AUTH_TOKEN: "ark-key",
          NODE_OPTIONS: "--require=/tmp/inject.js",
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Environment variable is not allowed: NODE_OPTIONS",
    });
  });

  it("waits for Anthropic state refresh before a credential mutation returns", async () => {
    let releaseRefresh!: () => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    rs.spyOn(deps.aiToolState, "refresh").mockImplementation(async (provider) => {
      expect(provider).toBe("anthropic");
      refreshStarted();
      await gate;
      return deps.aiToolState.get();
    });

    const response = Promise.resolve(
      app.request("/ai-tools/anthropic-compatible-credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "kimi", apiKey: "kimi-key" }),
      }),
    );
    await started;

    let settled = false;
    void response.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseRefresh();
    expect((await response).status).toBe(200);
  });

  it("removes stored credentials", async () => {
    await app.request("/ai-tools/anthropic-compatible-credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "deepseek", apiKey: "deepseek-key" }),
    });
    clearStoredAnthropicCompatibleAuthRevokedMock.mockClear();

    const remove = await app.request("/ai-tools/anthropic-compatible-credentials", {
      method: "DELETE",
    });
    expect(remove.status).toBe(200);
    expect(await remove.json()).toEqual({ ok: true });

    const [stored] = await testDb.db
      .select()
      .from(settings)
      .where(eq(settings.key, ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING));
    expect(stored).toBeUndefined();
    expect(clearStoredAnthropicCompatibleAuthRevokedMock).toHaveBeenCalledTimes(1);
  }, 15_000);
});

describe("Claude logout API", () => {
  it("clears the request-time revoked marker after a successful logout", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "rome-claude-logout-"));
    const originalPath = process.env.PATH;
    const testDb = createTestDb();

    try {
      await fs.writeFile(
        join(dir, "claude"),
        [
          "#!/bin/sh",
          'if [ "$1" = "auth" ] && [ "$2" = "logout" ]; then',
          "  exit 0",
          "fi",
          "exit 1",
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.PATH = `${dir}:${originalPath ?? ""}`;

      const deps = await buildTestDeps(testDb.db);
      let releaseRefresh!: () => void;
      const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      const refreshSpy = rs.spyOn(deps.aiToolState, "refresh").mockImplementation(async () => {
        await refreshGate;
        return deps.aiToolState.get();
      });
      const app = new Hono().route("/", aiToolsRoutes(deps));

      const response = Promise.resolve(app.request("/ai-tools/claude/logout", { method: "POST" }));
      await waitFor(() => refreshSpy.mock.calls.length === 1);
      let settled = false;
      void response.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseRefresh();
      const res = await response;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(clearClaudeAuthRevokedMock).toHaveBeenCalledTimes(1);
      expect(refreshSpy).toHaveBeenCalledWith("anthropic");
    } finally {
      testDb.close();
      process.env.PATH = originalPath;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
