import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { ProviderAdapter } from "./adapter.js";
import type { NormalizedMessage } from "./types.js";
import { wrapProviderAdaptersWithSpans } from "../telemetry.js";
import {
  buildMessage,
  installTestSpanHarness,
  MockProviderAdapter,
  type SpanHarness,
} from "../test/helpers.js";

describe("channel:{name}.handle span (composition-root wrapping)", () => {
  // `node` kind installs an AsyncHooks context manager so the
  // hook→channel parent-child link survives the await inside withRomeSpan.
  let harness: SpanHarness;

  beforeEach(() => {
    harness = installTestSpanHarness("node");
    // Suppress the inbound-message stdout log line so the reporter stays clean.
    rs.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    rs.restoreAllMocks();
    await harness.shutdown();
  });

  async function findChannelSpans(channel: string): Promise<ReadableSpan[]> {
    const all = await harness.finishedSpans();
    return all.filter((span) => span.name === `channel:${channel}.handle`);
  }

  it("emits a channel:{name}.handle span per handler invocation with normalized-message attrs", async () => {
    const adapter = new MockProviderAdapter("telegram");
    const adapters = new Map<string, ProviderAdapter>([["telegram", adapter]]);
    wrapProviderAdaptersWithSpans(adapters);

    const seen: string[] = [];
    adapter.onMessage(async (msg: NormalizedMessage) => {
      seen.push(msg.id);
    });

    await adapter.simulateMessage(
      buildMessage({
        channel: "telegram",
        threadId: "chat-42",
        channelUserId: "user-7",
        text: "hi",
      }),
    );

    expect(seen).toHaveLength(1);

    const spans = await findChannelSpans("telegram");
    expect(spans).toHaveLength(1);
    const attrs = spans[0].attributes;
    expect(attrs["channel.name"]).toBe("telegram");
    expect(attrs["channel.thread_id"]).toBe("chat-42");
    expect(attrs["channel.user_id"]).toBe("user-7");
  });

  it("parents the hook:channel-message span under channel:{name}.handle", async () => {
    const adapter = new MockProviderAdapter("webchat");
    const adapters = new Map<string, ProviderAdapter>([["webchat", adapter]]);
    wrapProviderAdaptersWithSpans(adapters);

    adapter.onMessage(async () => {});
    await adapter.simulateMessage(buildMessage({ channel: "webchat" }));

    const all = await harness.finishedSpans();
    const channelSpan = all.find((s) => s.name === "channel:webchat.handle");
    const hookSpan = all.find((s) => s.name === "hook:channel-message");
    expect(channelSpan).toBeDefined();
    expect(hookSpan).toBeDefined();
    expect(hookSpan!.parentSpanContext?.spanId).toBe(channelSpan!.spanContext().spanId);
  });

  it("records handler exceptions on the channel span (status=ERROR, exception event)", async () => {
    const adapter = new MockProviderAdapter("discord");
    const adapters = new Map<string, ProviderAdapter>([["discord", adapter]]);
    wrapProviderAdaptersWithSpans(adapters);

    adapter.onMessage(async () => {
      throw new Error("boom");
    });

    // MockProviderAdapter.simulateMessage rethrows whatever the handler throws.
    await expect(adapter.simulateMessage(buildMessage({ channel: "discord" }))).rejects.toThrow(
      "boom",
    );

    const [span] = await findChannelSpans("discord");
    // SpanStatusCode.ERROR === 2
    expect(span.status.code).toBe(2);
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });
});

describe("inbound channel message log (composition-root wrapping)", () => {
  let harness: SpanHarness;
  let exporter: InMemoryLogRecordExporter;
  let provider: LoggerProvider;

  beforeEach(() => {
    harness = installTestSpanHarness("node");
    exporter = new InMemoryLogRecordExporter();
    provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor(exporter)],
    });
    logs.setGlobalLoggerProvider(provider);
    // Suppress the mirrored stdout line so the test reporter stays clean.
    rs.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    rs.restoreAllMocks();
    logs.disable();
    await provider.shutdown();
    await harness.shutdown();
  });

  it("emits one log record per inbound message carrying the message content", async () => {
    const adapter = new MockProviderAdapter("whatsapp");
    const adapters = new Map<string, ProviderAdapter>([["whatsapp", adapter]]);
    wrapProviderAdaptersWithSpans(adapters);

    adapter.onMessage(async () => {});
    await adapter.simulateMessage(
      buildMessage({
        id: "msg-77",
        channel: "whatsapp",
        threadId: "chat-9",
        channelUserId: "user-3",
        text: "dinner at 8?",
      }),
    );

    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.body).toBe("channel message received");
    expect(record.severityText).toBe("info");
    expect(record.attributes.component).toBe("channels");
    expect(record.attributes.channel).toBe("whatsapp");
    expect(record.attributes.threadId).toBe("chat-9");
    expect(record.attributes.channelUserId).toBe("user-3");
    expect(record.attributes.messageId).toBe("msg-77");
    expect(record.attributes.text).toBe("dinner at 8?");
  });

  it("links the log record to the channel:{name}.handle span's trace", async () => {
    const adapter = new MockProviderAdapter("webchat");
    const adapters = new Map<string, ProviderAdapter>([["webchat", adapter]]);
    wrapProviderAdaptersWithSpans(adapters);

    adapter.onMessage(async () => {});
    await adapter.simulateMessage(buildMessage({ channel: "webchat" }));

    const spans = await harness.finishedSpans();
    const channelSpan = spans.find((s) => s.name === "channel:webchat.handle");
    expect(channelSpan).toBeDefined();

    const [record] = exporter.getFinishedLogRecords();
    expect(record.spanContext?.traceId).toBe(channelSpan!.spanContext().traceId);
    expect(record.spanContext?.spanId).toBe(channelSpan!.spanContext().spanId);
  });
});
