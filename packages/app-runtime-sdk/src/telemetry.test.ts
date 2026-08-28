import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { setTelemetryBridge, withSdkSpan } from "./index.js";

// Minimal OTEL-backed bridge impl for this test. In production this is
// installed by `packages/core/src/telemetry.ts`; we don't pull core in
// from the SDK test because the SDK is meant to stay OTEL-free at the
// package boundary.
function installOtelBridge(): void {
  setTelemetryBridge({
    withRomeSpan: (name, attrs, fn) => {
      const tracer = trace.getTracer("rome");
      return tracer.startActiveSpan(
        name,
        { attributes: attrs as Record<string, string | number | boolean> },
        async (span) => {
          try {
            return await fn();
          } finally {
            span.end();
          }
        },
      );
    },
    startRomeSpan: (name, attrs) => {
      trace
        .getTracer("rome")
        .startSpan(name, {
          attributes: attrs as Record<string, string | number | boolean>,
        })
        .end();
    },
    currentSessionId: () => undefined,
    runWithSession: (_sessionId, fn) => fn(),
  });
}

describe("withSdkSpan", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    installOtelBridge();
  });

  afterEach(async () => {
    setTelemetryBridge(null);
    await provider.shutdown();
    trace.disable();
  });

  it("emits a sdk:<method> span with sdk.method + caller attributes", async () => {
    const result = await withSdkSpan("foo.bar", { "rome.app.name": "demo" }, async () => "ok");

    expect(result).toBe("ok");

    const spans = exporter.getFinishedSpans();
    const sdkSpans = spans.filter((s) => s.name === "sdk:foo.bar");
    expect(sdkSpans).toHaveLength(1);

    const [span] = sdkSpans;
    expect(span.attributes["sdk.method"]).toBe("foo.bar");
    expect(span.attributes["rome.app.name"]).toBe("demo");
  });

  it("runs fn verbatim and emits no spans when no bridge is installed", async () => {
    setTelemetryBridge(null);

    const result = await withSdkSpan("unwired", { x: 1 }, async () => 42);

    expect(result).toBe(42);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
