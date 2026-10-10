import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { ChannelMessage, ConversationId, InboundEvent } from "@rome-os/app-runtime";
import { withInboundSpans } from "../telemetry.js";
import {
  createTestConnections,
  createTestDb,
  FakeTransport,
  installTestSpanHarness,
  noAccounts,
  type SpanHarness,
  type TestDb,
} from "../test/helpers.js";
import { channelList } from "./channel-list.js";

// The inbound instrumentation the channel-message hook hears every channel
// through, over the production channel list and fake transports.

let testDb: TestDb | undefined;

/**
 * Subscribes `handler` to the instrumented `channel` and answers a delivery
 * that resolves once the handler's spans have ended.
 */
function hear(
  channel: string,
  handler: (event: InboundEvent) => Promise<void> = async () => {},
): (overrides?: Partial<ChannelMessage>) => Promise<void> {
  testDb ??= createTestDb();
  const transport = new FakeTransport(channel);
  const channels = withInboundSpans(
    channelList({
      db: testDb.db,
      whatsAppAccounts: noAccounts,
      linkedInAccounts: noAccounts,
      connections: { registry: createTestConnections(new Map([[channel, transport]])) },
    }),
    "channel-message",
  );
  const inbound = channels.find((each) => each.name === channel)?.inbound;
  if (!inbound) throw new Error(`channel "${channel}" cannot receive`);
  let settle: (() => void) | undefined;
  inbound.subscribe(async (event) => {
    try {
      await handler(event);
    } finally {
      settle?.();
    }
  });
  return async (overrides = {}) => {
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    await transport.receive(overrides);
    await settled;
    // The spans end in the microtasks after the handler settles, and a
    // macrotask runs only once those have drained.
    await new Promise((resolve) => setImmediate(resolve));
  };
}

afterEach(() => {
  testDb?.close();
  testDb = undefined;
});

describe("channel:{name}.handle span", () => {
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

  async function spansNamed(name: string): Promise<ReadableSpan[]> {
    const all = await harness.finishedSpans();
    return all.filter((span) => span.name === name);
  }

  it("emits a channel:{name}.handle span per handled message with its attrs", async () => {
    const seen: string[] = [];
    const deliver = hear("telegram", async ({ message }) => {
      seen.push(message.messageId);
    });

    await deliver({
      messageId: "msg-1",
      conversationId: "chat-42" as ConversationId,
      senderId: "user-7",
      text: "hi",
    });

    expect(seen).toEqual(["msg-1"]);
    const spans = await spansNamed("channel:telegram.handle");
    expect(spans).toHaveLength(1);
    const attrs = spans[0].attributes;
    expect(attrs["channel.name"]).toBe("telegram");
    expect(attrs["channel.thread_id"]).toBe("chat-42");
    expect(attrs["channel.user_id"]).toBe("user-7");
  });

  it("parents the hook:channel-message span under channel:{name}.handle", async () => {
    const deliver = hear("discord");
    await deliver();

    const [channelSpan] = await spansNamed("channel:discord.handle");
    const [hookSpan] = await spansNamed("hook:channel-message");
    expect(channelSpan).toBeDefined();
    expect(hookSpan).toBeDefined();
    expect(hookSpan.parentSpanContext?.spanId).toBe(channelSpan.spanContext().spanId);
  });

  it("emits one hook:channel-message span per message, labelled with its channel", async () => {
    const telegram = hear("telegram");
    const feishu = hear("feishu");

    await telegram({ messageId: "msg-1", text: "hello" });
    await telegram({ messageId: "msg-2", text: "world" });
    await feishu({ messageId: "msg-3" });

    const spans = await spansNamed("hook:channel-message");
    expect(spans.map((span) => span.attributes["channel.name"])).toEqual([
      "telegram",
      "telegram",
      "feishu",
    ]);
    for (const span of spans) expect(span.attributes["hook.name"]).toBe("channel-message");
  });

  it("records a handler's exception on both spans", async () => {
    const deliver = hear("discord", async () => {
      throw new Error("boom");
    });
    // The channel reports a handler's failure in its own log and goes on.
    await deliver();

    for (const name of ["channel:discord.handle", "hook:channel-message"]) {
      const [span] = await spansNamed(name);
      // SpanStatusCode.ERROR === 2
      expect(span.status.code).toBe(2);
      expect(span.events.some((event) => event.name === "exception")).toBe(true);
    }
  });

  it("subscribes nothing until a handler subscribes", async () => {
    testDb ??= createTestDb();
    const transport = new FakeTransport("telegram");
    withInboundSpans(
      channelList({
        db: testDb.db,
        whatsAppAccounts: noAccounts,
        linkedInAccounts: noAccounts,
        connections: { registry: createTestConnections(new Map([["telegram", transport]])) },
      }),
      "channel-message",
    );

    await transport.receive();
    await new Promise((resolve) => setImmediate(resolve));

    expect(await harness.finishedSpans()).toEqual([]);
  });
});

describe("inbound channel message log", () => {
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

  function inboundRecords() {
    return exporter
      .getFinishedLogRecords()
      .filter((record) => record.body === "channel message received");
  }

  it("emits one log record per inbound message carrying the message content", async () => {
    const deliver = hear("whatsapp");
    await deliver({
      messageId: "msg-77",
      conversationId: "chat-9" as ConversationId,
      senderId: "user-3",
      text: "dinner at 8?",
    });

    const records = inboundRecords();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.severityText).toBe("info");
    expect(record.attributes.component).toBe("channels");
    expect(record.attributes.channel).toBe("whatsapp");
    expect(record.attributes.threadId).toBe("chat-9");
    expect(record.attributes.channelUserId).toBe("user-3");
    expect(record.attributes.messageId).toBe("msg-77");
    expect(record.attributes.text).toBe("dinner at 8?");
  });

  it("links the log record to the channel:{name}.handle span", async () => {
    const deliver = hear("telegram_user");
    await deliver();

    const spans = await harness.finishedSpans();
    const channelSpan = spans.find((span) => span.name === "channel:telegram_user.handle");
    expect(channelSpan).toBeDefined();

    const [record] = inboundRecords();
    expect(record.spanContext?.traceId).toBe(channelSpan!.spanContext().traceId);
    expect(record.spanContext?.spanId).toBe(channelSpan!.spanContext().spanId);
  });
});
