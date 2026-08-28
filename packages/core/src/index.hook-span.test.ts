import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { wrapHookSpan } from "./telemetry.js";
import { MockProviderAdapter, buildMessage } from "./test/helpers.js";
import type { ProviderAdapter } from "./channels/adapter.js";
import type { NormalizedMessage } from "./channels/types.js";

/**
 * Apply the same handler wrapping `packages/core/src/index.ts` performs at
 * the `channel.onMessage` boundary. Keeping this isolated here lets the test
 * assert the observable behavior (a span per handler fire) without booting
 * the full startup path.
 */
function instrumentAdaptersWithChannelMessageSpan(
  channelPorts: Map<string, ProviderAdapter>,
): void {
  for (const [name, adapter] of channelPorts) {
    const originalOnMessage = adapter.onMessage.bind(adapter);
    adapter.onMessage = (handler) => {
      originalOnMessage((msg) =>
        wrapHookSpan("channel-message", { "channel.name": name }, () => handler(msg)),
      );
    };
  }
}

describe("hook:channel-message span instrumentation", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    // Drop any previously registered global tracer provider so we can install
    // a fresh in-memory one. `setGlobalTracerProvider` silently no-ops when a
    // provider is already registered, so an explicit `disable()` is required.
    trace.disable();

    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.forceFlush();
    trace.disable();
    await provider.shutdown();
    exporter.reset();
  });

  function findChannelMessageSpans(): ReadableSpan[] {
    return exporter.getFinishedSpans().filter((span) => span.name === "hook:channel-message");
  }

  it("emits one hook:channel-message span per handler invocation", async () => {
    const adapter = new MockProviderAdapter("telegram");
    const adapters = new Map<string, ProviderAdapter>([["telegram", adapter]]);

    // Simulate the hook: register a handler after instrumentation.
    instrumentAdaptersWithChannelMessageSpan(adapters);

    let handlerCalls = 0;
    adapter.onMessage(async (_msg: NormalizedMessage) => {
      handlerCalls += 1;
    });

    // Registering alone must not emit any span.
    expect(findChannelMessageSpans()).toHaveLength(0);

    await adapter.simulateMessage(buildMessage({ text: "hello" }));
    await adapter.simulateMessage(buildMessage({ text: "world" }));

    expect(handlerCalls).toBe(2);

    const spans = findChannelMessageSpans();
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span.attributes["hook.name"]).toBe("channel-message");
      expect(span.attributes["channel.name"]).toBe("telegram");
    }
  });

  it("labels channel.name per adapter", async () => {
    const telegram = new MockProviderAdapter("telegram");
    const webchat = new MockProviderAdapter("webchat");
    const adapters = new Map<string, ProviderAdapter>([
      ["telegram", telegram],
      ["webchat", webchat],
    ]);

    instrumentAdaptersWithChannelMessageSpan(adapters);

    telegram.onMessage(async () => {});
    webchat.onMessage(async () => {});

    await telegram.simulateMessage(buildMessage({ channel: "telegram" }));
    await webchat.simulateMessage(buildMessage({ channel: "webchat" }));

    const spans = findChannelMessageSpans();
    expect(spans.map((s) => s.attributes["channel.name"])).toEqual(["telegram", "webchat"]);
  });

  it("records exceptions and still ends the span when the handler throws", async () => {
    const adapter = new MockProviderAdapter("discord");
    const adapters = new Map<string, ProviderAdapter>([["discord", adapter]]);

    instrumentAdaptersWithChannelMessageSpan(adapters);

    adapter.onMessage(async () => {
      throw new Error("boom");
    });

    await expect(adapter.simulateMessage(buildMessage({ channel: "discord" }))).rejects.toThrow(
      "boom",
    );

    const spans = findChannelMessageSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(2); // SpanStatusCode.ERROR
    expect(spans[0].events.some((e) => e.name === "exception")).toBe(true);
  });
});
