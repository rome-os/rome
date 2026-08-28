import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { createAppLogger, createLogger } from "./logger.js";
import { runWithSession } from "./telemetry-context.js";

// Each test stands up an isolated LoggerProvider so we can assert that
// `createLogger` mirrors every entry to the OTEL log pipeline. The OTEL
// global LoggerProvider registry holds the provider until we explicitly
// disable it — `afterEach` shuts down to avoid cross-test bleed.
function withMemoryProvider(): {
  exporter: InMemoryLogRecordExporter;
  shutdown: () => Promise<void>;
} {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor(exporter)],
  });
  logs.setGlobalLoggerProvider(provider);
  return {
    exporter,
    shutdown: async () => {
      logs.disable();
      await provider.shutdown();
    },
  };
}

describe("createLogger OTLP emission", () => {
  let shutdown: (() => Promise<void>) | undefined;
  let exporter: InMemoryLogRecordExporter;

  beforeEach(() => {
    const setup = withMemoryProvider();
    exporter = setup.exporter;
    shutdown = setup.shutdown;
    // Suppress stdout noise so the test reporter stays clean.
    rs.spyOn(console, "log").mockImplementation(() => {});
    rs.spyOn(console, "warn").mockImplementation(() => {});
    rs.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    rs.restoreAllMocks();
    if (shutdown) await shutdown();
    shutdown = undefined;
  });

  it("emits one OTLP log record per logger call with severity, body, and component", () => {
    const log = createLogger("test-component");
    log.info("hello world");

    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0].body).toBe("hello world");
    expect(records[0].severityText).toBe("info");
    expect(records[0].severityNumber).toBe(SeverityNumber.INFO);
    expect(records[0].attributes.component).toBe("test-component");
    expect(records[0].attributes["rome.log.source"]).toBe("rome");
    expect(records[0].instrumentationScope.name).toBe("rome");
  });

  it("identifies app-owned logs and their app id", () => {
    const log = createAppLogger("app:terminal", "terminal");
    log.info("pty spawned");

    const [record] = exporter.getFinishedLogRecords();
    expect(record.attributes["rome.log.source"]).toBe("rome-apps");
    expect(record.attributes["rome.app.id"]).toBe("terminal");
    expect(record.instrumentationScope.name).toBe("rome-apps");
  });

  it("flattens primitive data fields onto LogAttributes", () => {
    const log = createLogger("api");
    log.warn("rate limit", { route: "/x", remaining: 0, allowed: false });

    const [record] = exporter.getFinishedLogRecords();
    expect(record.attributes.route).toBe("/x");
    expect(record.attributes.remaining).toBe(0);
    expect(record.attributes.allowed).toBe(false);
    expect(record.severityText).toBe("warn");
  });

  it("stamps session.id on the record when inside a session context", () => {
    const log = createLogger("worker");
    runWithSession("sess-xyz", () => {
      log.error("boom");
    });

    const [record] = exporter.getFinishedLogRecords();
    expect(record.attributes["session.id"]).toBe("sess-xyz");
    expect(record.severityNumber).toBe(SeverityNumber.ERROR);
  });

  it("respects LOG_LEVEL gating — debug below info is dropped from OTLP too", () => {
    const log = createLogger("quiet");
    log.debug("noise");

    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
  });

  it("stringifies non-primitive data exactly once across both sinks", () => {
    const stdoutSpy = rs.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("dual");
    const nested = { a: 1, b: [2, 3] };

    log.info("event", { simple: "x", nested });

    // OTEL: nested object arrives as a pre-stringified JSON string in the flat map.
    const [record] = exporter.getFinishedLogRecords();
    expect(record.attributes.simple).toBe("x");
    expect(record.attributes.nested).toBe(JSON.stringify(nested));

    // stdout: same pre-stringified value lives under entry.data so the outer
    // JSON.stringify never recurses into the nested subtree.
    const stdoutLine = stdoutSpy.mock.calls.at(-1)?.[0] as string;
    const parsed = JSON.parse(stdoutLine) as {
      data: { simple: string; nested: string };
    };
    expect(parsed.data.simple).toBe("x");
    expect(typeof parsed.data.nested).toBe("string");
    expect(parsed.data.nested).toBe(JSON.stringify(nested));
  });
});
