import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect, beforeEach, rs } from "@rstest/core";
import { loadConfig } from "./config.js";
import { DEFAULT_SQLITE_PATH } from "./db/index.js";

/**
 * Wipe all config-relevant env vars before each test so that
 * `rs.stubEnv()` calls within each test are the only source of config.
 */
const CONFIG_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "DATABASE_TYPE",
  "SQLITE_PATH",
  "SQLITE_ENCRYPTION_KEY",
  "POSTGRES_CONNECTION_STRING",
  "ROME_ACTION_MAX_WORKERS",
  "ROME_COMPUTER_USE_LOCAL_DEVICE_ID",
  "ROME_HOST_EXECUTION_SOCKET",
  "ROME_HOST_EXECUTION_ENABLED",
  "ROME_ENABLE_CDP_AUTOMATION",
  "ROME_JWT_SECRET",
  "WEB_PORT",
  "WEB_HOST",
  "INTERNAL_API_PORT",
  "INTERNAL_API_WEBHOOK_API_KEY",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "RELAY_DRAIN_URL",
  "RELAY_DRAIN_KEY",
] as const;

beforeEach(() => {
  rs.unstubAllEnvs();
  for (const key of CONFIG_ENV_KEYS) {
    rs.stubEnv(key, undefined as unknown as string);
    delete process.env[key];
  }
});

describe("loadConfig()", () => {
  it("disables CDP automation by default", () => {
    expect(loadConfig().cdpAutomationEnabled).toBe(false);
  });

  it.each([
    ["true", true],
    ["false", false],
  ] as const)("parses ROME_ENABLE_CDP_AUTOMATION=%s", (value, enabled) => {
    rs.stubEnv("ROME_ENABLE_CDP_AUTOMATION", value);
    expect(loadConfig().cdpAutomationEnabled).toBe(enabled);
  });

  it.each(["1", "yes", "", "invalid"])("rejects an invalid CDP automation flag: %s", (value) => {
    rs.stubEnv("ROME_ENABLE_CDP_AUTOMATION", value);
    expect(() => loadConfig()).toThrow("Invalid configuration");
  });

  it("disables host execution and leaves its socket unset by default", () => {
    expect(loadConfig()).toMatchObject({ hostExecutionEnabled: false });
    expect(loadConfig().hostExecutionSocket).toBeUndefined();
  });

  it("requires explicit host execution enablement and an absolute socket path", () => {
    rs.stubEnv("ROME_HOST_EXECUTION_ENABLED", "true");
    rs.stubEnv("ROME_HOST_EXECUTION_SOCKET", "/run/rome-host/control.sock");
    expect(loadConfig()).toMatchObject({
      hostExecutionEnabled: true,
      hostExecutionSocket: "/run/rome-host/control.sock",
    });
    rs.stubEnv("ROME_HOST_EXECUTION_ENABLED", "yes");
    expect(() => loadConfig()).toThrow("Invalid configuration");
    rs.stubEnv("ROME_HOST_EXECUTION_ENABLED", "false");
    rs.stubEnv("ROME_HOST_EXECUTION_SOCKET", "https://host.example");
    expect(() => loadConfig()).toThrow("Invalid configuration");
  });
  it("parses valid env and returns typed config", () => {
    rs.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");

    const config = loadConfig();

    expect(config.anthropicApiKey).toBe("sk-ant-test-key");
    expect(config.database.type).toBe("sqlite");
    expect(config.webServer).toEqual({ port: 3000, host: "localhost" });
  });

  it("allows missing ANTHROPIC_API_KEY (optional)", () => {
    const config = loadConfig();
    expect(config.anthropicApiKey).toBeUndefined();
  });

  it("defaults DATABASE_TYPE to 'sqlite'", () => {
    const config = loadConfig();
    expect(config.database.type).toBe("sqlite");
  });

  it("defaults SQLITE_PATH when DATABASE_TYPE=sqlite", () => {
    const config = loadConfig();

    expect(config.database.type).toBe("sqlite");
    if (config.database.type === "sqlite") {
      expect(config.database.sqlitePath).toBe(DEFAULT_SQLITE_PATH);
    }
  });

  it("validates POSTGRES_CONNECTION_STRING is required when DATABASE_TYPE=postgresql", () => {
    rs.stubEnv("DATABASE_TYPE", "postgresql");

    expect(() => loadConfig()).toThrow(
      "POSTGRES_CONNECTION_STRING is required when DATABASE_TYPE=postgresql",
    );
  });

  it("accepts valid postgresql config", () => {
    rs.stubEnv("DATABASE_TYPE", "postgresql");
    rs.stubEnv("POSTGRES_CONNECTION_STRING", "postgresql://localhost:5432/rome");

    const config = loadConfig();

    expect(config.database.type).toBe("postgresql");
    if (config.database.type === "postgresql") {
      expect(config.database.postgresConnectionString).toBe("postgresql://localhost:5432/rome");
    }
  });

  it("accepts a valid ws/wss RELAY_DRAIN_URL with both relay vars set", () => {
    rs.stubEnv("RELAY_DRAIN_URL", "wss://relay.example/c/mb1");
    rs.stubEnv("RELAY_DRAIN_KEY", "secret-key");

    const config = loadConfig();
    expect(config.relay).toEqual({ drainUrl: "wss://relay.example/c/mb1", drainKey: "secret-key" });
  });

  it("rejects a RELAY_DRAIN_URL that is not a ws/wss /c/ drain URL", () => {
    rs.stubEnv("RELAY_DRAIN_URL", "https://relay.example/c/mb1");
    rs.stubEnv("RELAY_DRAIN_KEY", "secret-key");

    expect(() => loadConfig()).toThrow(/Invalid configuration/);
  });

  it("rejects a RELAY_DRAIN_URL without a /c/ mailbox path", () => {
    rs.stubEnv("RELAY_DRAIN_URL", "wss://relay.example/h/mb1");
    rs.stubEnv("RELAY_DRAIN_KEY", "secret-key");

    expect(() => loadConfig()).toThrow(/Invalid configuration/);
  });

  it("rejects a relay seed missing the drain key", () => {
    rs.stubEnv("RELAY_DRAIN_URL", "wss://relay.example/c/mb1");

    expect(() => loadConfig()).toThrow(/Invalid configuration/);
  });

  it("leaves the action-worker process cap to the host unless overridden", () => {
    expect(loadConfig().actionWorkerMaxProcesses).toBeUndefined();

    rs.stubEnv("ROME_ACTION_MAX_WORKERS", "5");
    expect(loadConfig().actionWorkerMaxProcesses).toBe(5);
  });

  it("accepts custom SQLITE_PATH", () => {
    rs.stubEnv("SQLITE_PATH", "/tmp/test.db");

    expect(loadConfig().database).toMatchObject({ type: "sqlite", sqlitePath: "/tmp/test.db" });
  });

  it("passes through SQLITE_ENCRYPTION_KEY", () => {
    rs.stubEnv("SQLITE_ENCRYPTION_KEY", "secret123");

    expect(loadConfig().database).toMatchObject({ type: "sqlite", encryptionKey: "secret123" });
  });

  it("accepts INTERNAL_API_WEBHOOK_API_KEY", () => {
    rs.stubEnv("INTERNAL_API_WEBHOOK_API_KEY", "whk_test_123");

    const config = loadConfig();

    expect(config.internalApi.webhookApiKey).toBe("whk_test_123");
  });

  it("treats empty ROME_COMPUTER_USE_LOCAL_DEVICE_ID as unset", () => {
    rs.stubEnv("ROME_COMPUTER_USE_LOCAL_DEVICE_ID", "   ");
    expect(loadConfig().computerUseLocalDeviceId).toBeUndefined();
  });

  it("rejects ROME_COMPUTER_USE_LOCAL_DEVICE_ID when effective JWT_SECRET does not match a 32+ char ROME_JWT_SECRET", () => {
    rs.stubEnv("ROME_COMPUTER_USE_LOCAL_DEVICE_ID", "ee969ec6-1944-4e85-9fd3-31ec802f8e02");
    expect(() => loadConfig()).toThrow("ROME_JWT_SECRET");

    rs.stubEnv("ROME_JWT_SECRET", "short-secret");
    expect(() => loadConfig()).toThrow("ROME_JWT_SECRET");

    // Even a long secret set after access/auth.ts initialized JWT_SECRET must fail closed.
    rs.stubEnv("ROME_JWT_SECRET", "x".repeat(40));
    expect(() => loadConfig()).toThrow("ROME_JWT_SECRET");
  });

  it("loads .env before auth modules so local computer use validates and uses the .env JWT secret", () => {
    const indexSource = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(indexSource.trimStart().startsWith('import "dotenv/config";')).toBe(true);

    const tempDir = mkdtempSync(join(tmpdir(), "rome-config-dotenv-"));
    const secret = "prod-secret-loaded-from-dotenv-0123456789abcdef";
    const deviceId = "EE969EC6-1944-4E85-9FD3-31EC802F8E02";
    const authUrl = pathToFileURL(join(import.meta.dirname, "access/auth.ts")).href;
    const configUrl = pathToFileURL(join(import.meta.dirname, "config.ts")).href;
    const req = createRequire(import.meta.url);
    const tsxPath = req.resolve("tsx");
    const dotenvConfigUrl = pathToFileURL(req.resolve("dotenv/config")).href;
    const jwtUrl = pathToFileURL(req.resolve("jsonwebtoken")).href;

    try {
      writeFileSync(
        join(tempDir, ".env"),
        `ROME_COMPUTER_USE_LOCAL_DEVICE_ID=${deviceId}\nROME_JWT_SECRET=${secret}\n`,
      );
      const env = { ...process.env };
      delete env.ROME_JWT_SECRET;
      delete env.ROME_COMPUTER_USE_LOCAL_DEVICE_ID;

      // Loading dotenv/config first (matching index.ts line 1) initializes JWT_SECRET from .env.
      const okOutput = execFileSync(
        process.execPath,
        [
          "--import",
          tsxPath,
          "--input-type=module",
          "-e",
          `
            await import(${JSON.stringify(dotenvConfigUrl)});
            const jwt = (await import(${JSON.stringify(jwtUrl)})).default;
            const auth = await import(${JSON.stringify(authUrl)});
            const { loadConfig } = await import(${JSON.stringify(configUrl)});
            const cfg = loadConfig();
            const forged = jwt.sign({ userId: "guardian" }, "rome-dev-secret-change-me");
            console.log(JSON.stringify({
              deviceId: cfg.computerUseLocalDeviceId,
              secretMatches: auth.JWT_SECRET === ${JSON.stringify(secret)},
              forgedAccepted: auth.verifySession(forged) !== null,
            }));
          `,
        ],
        { cwd: tempDir, env, encoding: "utf8" },
      );
      expect(JSON.parse(okOutput.trim())).toEqual({
        deviceId: deviceId.toLowerCase(),
        secretMatches: true,
        forgedAccepted: false,
      });

      // Importing access/auth.ts before dotenv/config must fail closed in loadConfig().
      const failOutput = execFileSync(
        process.execPath,
        [
          "--import",
          tsxPath,
          "--input-type=module",
          "-e",
          `
            await import(${JSON.stringify(authUrl)});
            const { loadConfig } = await import(${JSON.stringify(configUrl)});
            try {
              loadConfig();
              console.log("PASSED");
            } catch (err) {
              console.log("THREW:" + (err instanceof Error ? err.message : String(err)));
            }
          `,
        ],
        { cwd: tempDir, env, encoding: "utf8" },
      );
      expect(failOutput.trim()).toContain(
        "THREW:Protected device use requires an explicit ROME_JWT_SECRET",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
