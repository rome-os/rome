import { describe, it, expect, beforeEach, rs } from "@rstest/core";
import { loadConfig } from "./config.js";
import { DEFAULT_SQLITE_PATH } from "./db/index.js";

/**
 * Wipe all config-relevant env vars before each test so that
 * `rs.stubEnv()` calls within each test are the only source of config.
 */
const CONFIG_ENV_KEYS = [
  "PANTHEON_SLUG",
  "ANTHROPIC_API_KEY",
  "DATABASE_TYPE",
  "SQLITE_PATH",
  "SQLITE_ENCRYPTION_KEY",
  "POSTGRES_CONNECTION_STRING",
  "SENTINEL_REVIEW_INTERVAL_MINUTES",
  "ROME_ACTION_MAX_WORKERS",
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
  it("parses valid env and returns typed config", () => {
    rs.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");

    const config = loadConfig();

    expect(config.anthropicApiKey).toBe("sk-ant-test-key");
    expect(config.database.type).toBe("sqlite");
    expect(config.sentinelReviewIntervalMinutes).toBe(120);
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

  it("defaults sentinel review interval to 120 minutes", () => {
    const config = loadConfig();
    expect(config.sentinelReviewIntervalMinutes).toBe(120);
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

  it("overrides sentinel interval via SENTINEL_REVIEW_INTERVAL_MINUTES", () => {
    rs.stubEnv("SENTINEL_REVIEW_INTERVAL_MINUTES", "60");

    const config = loadConfig();
    expect(config.sentinelReviewIntervalMinutes).toBe(60);
  });

  it("defaults and overrides the action-worker process cap", () => {
    expect(loadConfig().actionWorkerMaxProcesses).toBe(8);

    rs.stubEnv("ROME_ACTION_MAX_WORKERS", "5");
    expect(loadConfig().actionWorkerMaxProcesses).toBe(5);
  });

  it("accepts custom SQLITE_PATH", () => {
    rs.stubEnv("SQLITE_PATH", "/tmp/test.db");

    const config = loadConfig();
    expect(config.database.type).toBe("sqlite");
    if (config.database.type === "sqlite") {
      expect(config.database.sqlitePath).toBe("/tmp/test.db");
    }
  });

  it("passes through SQLITE_ENCRYPTION_KEY", () => {
    rs.stubEnv("SQLITE_ENCRYPTION_KEY", "secret123");

    const config = loadConfig();
    if (config.database.type === "sqlite") {
      expect(config.database.encryptionKey).toBe("secret123");
    }
  });

  it("surfaces PANTHEON_SLUG as the instance slug", () => {
    rs.stubEnv("PANTHEON_SLUG", "feature-foo");

    const config = loadConfig();
    expect(config.instanceSlug).toBe("feature-foo");
  });

  it("leaves the instance slug undefined when PANTHEON_SLUG is unset", () => {
    const config = loadConfig();
    expect(config.instanceSlug).toBeUndefined();
  });

  it("treats a blank PANTHEON_SLUG as no slug", () => {
    rs.stubEnv("PANTHEON_SLUG", "   ");

    const config = loadConfig();
    expect(config.instanceSlug).toBeUndefined();
  });

  it("trims surrounding whitespace from the instance slug", () => {
    rs.stubEnv("PANTHEON_SLUG", "  prod-tenant-7  ");

    const config = loadConfig();
    expect(config.instanceSlug).toBe("prod-tenant-7");
  });

  it("accepts INTERNAL_API_WEBHOOK_API_KEY", () => {
    rs.stubEnv("INTERNAL_API_WEBHOOK_API_KEY", "whk_test_123");

    const config = loadConfig();

    expect(config.internalApi.webhookApiKey).toBe("whk_test_123");
  });
});
