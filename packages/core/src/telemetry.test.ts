import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import {
  buildResourceAttributes,
  modelTokenMetricAttributes,
  resolveTelemetryEndpoint,
} from "./telemetry.js";

describe("modelTokenMetricAttributes", () => {
  it("includes agent and app attribution for app-owned agents", () => {
    expect(
      modelTokenMetricAttributes("claude-test", "in", {
        agentName: "researcher",
        appStoreListingId: "@rome/research",
      }),
    ).toEqual({
      model: "claude-test",
      direction: "in",
      "agent.name": "researcher",
      "rome.app.id": "@rome/research",
    });
  });

  it("omits app attribution for core-owned agents", () => {
    expect(modelTokenMetricAttributes("gpt-test", "out", { agentName: "main" })).toEqual({
      model: "gpt-test",
      direction: "out",
      "agent.name": "main",
    });
  });
});

describe("buildResourceAttributes", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PANTHEON_SLUG;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("emits the three standard OTEL semantic attributes", () => {
    process.env.PANTHEON_SLUG = "feature-foo";
    process.env.NODE_ENV = "development";

    const attrs = buildResourceAttributes();

    expect(attrs["service.name"]).toBe("rome");
    expect(attrs["service.instance.id"]).toBe("feature-foo");
    expect(attrs["deployment.environment"]).toBe("development");
  });

  it("falls back to unknown instance id and development environment when env vars are absent", () => {
    const attrs = buildResourceAttributes();

    expect(attrs["service.instance.id"]).toBe("unknown");
    expect(attrs["deployment.environment"]).toBe("development");
  });
});

describe("resolveTelemetryEndpoint", () => {
  it("uses an explicit OTEL endpoint in production", () => {
    expect(
      resolveTelemetryEndpoint(
        {
          NODE_ENV: "production",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.example:4318",
        },
        true,
      ),
    ).toBe("http://otel.example:4318");
  });

  it("does not default to rome-obs in production Docker", () => {
    expect(resolveTelemetryEndpoint({ NODE_ENV: "production" }, true)).toBeUndefined();
  });

  it("keeps the in-container default for development Docker", () => {
    expect(resolveTelemetryEndpoint({ NODE_ENV: "development" }, true)).toBe(
      "http://rome-obs:4318",
    );
  });
});
