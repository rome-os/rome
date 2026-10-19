import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@rstest/core";
import { SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { node as nodeTracing } from "@opentelemetry/sdk-node";
import {
  buildResourceAttributes,
  modelTokenMetricAttributes,
  resolveTelemetryEndpoint,
  withTracingSuppressed,
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

describe("withTracingSuppressed", () => {
  const exporter = new nodeTracing.InMemorySpanExporter();
  const provider = new nodeTracing.NodeTracerProvider({
    spanProcessors: [new nodeTracing.SimpleSpanProcessor(exporter)],
  });
  let instrumentations: ReturnType<typeof getNodeAutoInstrumentations>;
  let closedPortUrl: string;

  beforeAll(async () => {
    provider.register();
    // Build the undici instrumentation the way initTelemetry() does, without
    // patching every other module this test worker loads.
    const previous = process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
    process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = "undici";
    try {
      instrumentations = getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-runtime-node": { enabled: false },
      });
    } finally {
      if (previous === undefined) delete process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
      else process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = previous;
    }
    // Reserve a loopback port, then release it so every connect is refused.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    closedPortUrl = `http://127.0.0.1:${address.port}/api/health`;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    for (const instrumentation of instrumentations) instrumentation.disable();
    context.disable();
    propagation.disable();
    trace.disable();
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
  });

  // The undici span ends a tick after fetch rejects, so wait before reading.
  async function refusedFetchSpans() {
    await delay(200);
    return exporter.getFinishedSpans().map((span) => span.status.code);
  }

  it("records a refused fetch as an Error span outside the wrapper", async () => {
    await fetch(closedPortUrl).catch(() => undefined);
    expect(await refusedFetchSpans()).toEqual([SpanStatusCode.ERROR]);
  });

  it("records no span for a refused fetch inside the wrapper", async () => {
    await withTracingSuppressed(() => fetch(closedPortUrl).catch(() => undefined));
    expect(await refusedFetchSpans()).toEqual([]);
  });

  it("returns the wrapped result and rethrows its error", async () => {
    await expect(withTracingSuppressed(async () => 42)).resolves.toBe(42);
    await expect(
      withTracingSuppressed(async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
  });
});
