import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
// OTLP/HTTP with protobuf body — more compact than JSON and universally
// understood by every OTEL collector, including HyperDX's bundle.
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  type Attributes,
  type Counter,
  type Histogram,
  type Span,
  type Tracer,
  metrics as apiMetrics,
  diag,
  trace,
  DiagConsoleLogger,
  DiagLogLevel,
  SpanStatusCode,
} from "@opentelemetry/api";
import { setTelemetryBridge } from "@rome-os/app-runtime";
import { currentSessionId, runWithSession } from "./telemetry-context.js";
import { resolveInstanceSlug, runningInsideDocker } from "./lib/runtime.js";
import { createLogger } from "./logger.js";

const SERVICE_NAME = "rome";
const METER_NAME = "rome";

// Default OTLP target inside the Rome dev container: the rome-obs singleton,
// reachable via the shared rome-edge network (see infra/observability/
// compose.yml). Prod overrides with a Rome-Cloud-injected endpoint.
const IN_CONTAINER_DEFAULT_ENDPOINT = "http://rome-obs:4318";

let sdk: NodeSDK | undefined;

export function resolveTelemetryEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  insideDocker = runningInsideDocker(),
): string | undefined {
  const fromEnv = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (fromEnv) return fromEnv;
  if (insideDocker && (env.NODE_ENV ?? "development") !== "production") {
    return IN_CONTAINER_DEFAULT_ENDPOINT;
  }
  return undefined;
}

function resolveInstanceId(): string {
  return resolveInstanceSlug() ?? "unknown";
}

function resolveEnvironment(): string {
  // deployment.environment mirrors NODE_ENV — "development" in dev,
  // "production" in prod. No separate env var needed.
  return process.env.NODE_ENV ?? "development";
}

/**
 * Build the resource attributes Rome injects at init. `initTelemetry()`
 * serializes these into `OTEL_RESOURCE_ATTRIBUTES` for NodeSDK's envDetector.
 */
export function buildResourceAttributes(): Record<string, string> {
  return {
    "service.name": SERVICE_NAME,
    "service.instance.id": resolveInstanceId(),
    "deployment.environment": resolveEnvironment(),
  };
}

function serializeResourceAttributes(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

export function initTelemetry(): void {
  // The action-worker bootstrap initializes telemetry before loading the worker
  // runtime, whose dependency graph includes pg. Keep this idempotent because
  // the runtime also calls initTelemetry() as a defensive fallback.
  if (sdk) return;

  const endpoint = resolveTelemetryEndpoint();

  if (!endpoint) {
    diag.info("OTEL endpoint unresolved, telemetry disabled");
    return;
  }

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  // Standard OTEL semantic attributes. `service.instance.id` is the shared
  // partition key across dev (worktree slug) and prod (tenant slug); the
  // coding agent and operators both scope queries against it. NodeSDK's
  // default envDetector picks these up from OTEL_RESOURCE_ATTRIBUTES.
  const serialized = serializeResourceAttributes(buildResourceAttributes());
  const existing = process.env.OTEL_RESOURCE_ATTRIBUTES;
  process.env.OTEL_RESOURCE_ATTRIBUTES = existing ? `${existing},${serialized}` : serialized;
  process.env.OTEL_SERVICE_NAME = SERVICE_NAME;

  const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
  const metricExporter = new OTLPMetricExporter({
    url: `${endpoint}/v1/metrics`,
  });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 15_000,
  });
  const logExporter = new OTLPLogExporter({ url: `${endpoint}/v1/logs` });
  const logRecordProcessor = new BatchLogRecordProcessor(logExporter);

  sdk = new NodeSDK({
    traceExporter,
    metricReaders: [metricReader],
    logRecordProcessors: [logRecordProcessor],
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
    instrumentations: [
      getNodeAutoInstrumentations({
        // The runtime-node instrumentation is the sole source of the
        // `v8js.*` and `nodejs.eventloop.*` gauges. It samples on a fixed
        // timer regardless of activity, so it dominates metric ingestion
        // while nothing downstream queries it. Disable it; all other
        // auto-instrumentations (HTTP, etc.) and Rome's own metrics stay on.
        "@opentelemetry/instrumentation-runtime-node": { enabled: false },
      }),
    ],
  });

  sdk.start();
}

export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

/**
 * Start a Rome-convention span: the current session id (from
 * `telemetry-context`) is stamped automatically, any caller-provided
 * attributes are merged, and exceptions are recorded with `ERROR` status.
 * Use for call-and-return work. For generator bodies, create a span with
 * `getTracer("rome").startSpan(...)` directly so you can control the
 * lifetime across yields.
 */
export async function withRomeSpan<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer("rome");
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    const sessionId = currentSessionId();
    if (sessionId) span.setAttribute("session.id", sessionId);
    try {
      return await fn(span);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      if (err instanceof Error) span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Create a detached span for long-lived work (e.g., an async generator
 * whose lifetime spans many yields). The caller must call
 * `span.end()` and `span.recordException()` / `setStatus(ERROR)` on failure.
 * Session id is stamped at creation time.
 */
export function startRomeSpan(name: string, attrs: Attributes = {}): Span {
  const tracer = getTracer("rome");
  const span = tracer.startSpan(name, { attributes: attrs });
  const sessionId = currentSessionId();
  if (sessionId) span.setAttribute("session.id", sessionId);
  return span;
}

/**
 * Thin wrapper over `withRomeSpan` for hook instrumentation. Emits a
 * `hook:{hookName}` span with `hook.name` already populated.
 */
export function wrapHookSpan<T>(
  hookName: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withRomeSpan(`hook:${hookName}`, { "hook.name": hookName, ...attrs }, fn);
}

const channelInboundLog = createLogger("channels");

/**
 * Emit the one "channel message received" log record for an inbound channel
 * message, carrying its content. `createLogger` mirrors it to `otel_logs`,
 * and the OTEL logger stamps the active span context, so call this inside
 * whatever span covers the delivery. Two boundaries emit it: the
 * `ProviderAdapter.onMessage` wrapper below (every adapter-delivered channel),
 * and the webchat accepted-turn boundary in `api/routes/webchat.ts`
 * routes webchat's primary chat surface around `onMessage`, so it must log
 * where turns are actually accepted.
 */
export function logInboundChannelMessage(msg: {
  channel: string;
  threadId: string;
  channelUserId: string;
  messageId: string;
  text: string;
}): void {
  channelInboundLog.info("channel message received", {
    channel: msg.channel,
    threadId: msg.threadId,
    channelUserId: msg.channelUserId,
    messageId: msg.messageId,
    text: msg.text,
  });
}

/**
 * Wrap each adapter's `onMessage` so every handler invocation produces a
 * `channel:{name}.handle` → `hook:channel-message` span pair, plus one
 * inbound-message log record (see `logInboundChannelMessage`) linked to the
 * channel span. Wrapping at the adapter boundary (before the hook registers)
 * gives one span per fire, not per register, and keeps instrumentation at
 * the neutral `ProviderAdapter` contract — concrete adapter impls stay span-free.
 *
 * Structurally typed (rather than importing `ProviderAdapter`/`NormalizedMessage`)
 * so telemetry doesn't depend on the channels module. Used by both production
 * startup (`packages/core/src/index.ts`) and the golden-trace test rig so
 * divergence is impossible.
 */
export function wrapProviderAdaptersWithSpans<
  M extends { id: string; channel: string; threadId: string; channelUserId: string; text: string },
  A extends { onMessage(handler: (msg: M) => Promise<void>): void },
>(adapters: Map<string, A>): void {
  for (const [name, adapter] of adapters) {
    const originalOnMessage = adapter.onMessage.bind(adapter);
    adapter.onMessage = (handler) => {
      originalOnMessage((msg) =>
        withRomeSpan(
          `channel:${name}.handle`,
          {
            "channel.name": msg.channel,
            "channel.thread_id": msg.threadId,
            "channel.user_id": msg.channelUserId,
          },
          () => {
            logInboundChannelMessage({
              channel: msg.channel,
              threadId: msg.threadId,
              channelUserId: msg.channelUserId,
              messageId: msg.id,
              text: msg.text,
            });
            return wrapHookSpan("channel-message", { "channel.name": name }, () => handler(msg));
          },
        ),
      );
    };
  }
}

export async function shutdown(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
  }
}

// Register telemetry impls with the SDK bridge so apps can call
// `withRomeSpan` / `startRomeSpan` / `runWithSession` / `currentSessionId`
// from `@rome-os/app-runtime` without depending on `@opentelemetry/api`.
// Registered at module load — no OTEL init is required for session
// propagation and no-op spans to work.
setTelemetryBridge({
  withRomeSpan: (name, attrs, fn) => withRomeSpan(name, attrs as Attributes, fn),
  startRomeSpan: (name, attrs = {}) => {
    startRomeSpan(name, attrs as Attributes).end();
  },
  currentSessionId,
  runWithSession,
});

// Metric instruments (lazy-init, cached).
//
// Instruments are created on first use rather than at module import time so
// tests (and other consumers that never call `initTelemetry()`) can safely
// import this module without triggering MeterProvider initialisation. The
// metrics API in `@opentelemetry/api` degrades to no-op recorders when no
// MeterProvider is installed, so the calls below are always safe.

function lazyDurationHistogram(name: string, description: string): () => Histogram {
  let cached: Histogram | undefined;
  return () => {
    if (!cached) {
      cached = apiMetrics.getMeter(METER_NAME).createHistogram(name, { unit: "ms", description });
    }
    return cached;
  };
}

function lazyCounter(name: string, description: string): () => Counter {
  let cached: Counter | undefined;
  return () => {
    if (!cached) {
      cached = apiMetrics.getMeter(METER_NAME).createCounter(name, { description });
    }
    return cached;
  };
}

export const modelTurnDurationMetric = lazyDurationHistogram(
  "rome.model.turn.duration",
  "Wall-clock duration of a single SDK query (one Rome turn).",
);

export const modelTokensMetric = lazyCounter(
  "rome.model.tokens",
  'Token count per model call, labelled by direction ("in"|"out"), model id, agent, and optional Rome Cloud App Store listing id.',
);

export interface ModelMetricAttribution {
  agentName?: string;
  /** Full logical Rome Cloud listing id, e.g. `@publisher/app`; absent for local apps. */
  appStoreListingId?: string;
}

export function modelTokenMetricAttributes(
  model: string,
  direction: "in" | "out",
  attribution: ModelMetricAttribution,
): Attributes {
  return {
    model,
    direction,
    ...(attribution.agentName ? { "agent.name": attribution.agentName } : {}),
    ...(attribution.appStoreListingId ? { "rome.app.id": attribution.appStoreListingId } : {}),
  };
}

export const actionDurationMetric = lazyDurationHistogram(
  "rome.action.duration",
  "Duration of a single action execution, labelled by action name.",
);

export const hookDurationMetric = lazyDurationHistogram(
  "rome.hook.duration",
  "Duration of a single hook invocation, labelled by hook name.",
);

export const sessionDurationMetric = lazyDurationHistogram(
  "rome.session.duration",
  "Total wall-clock duration of an agent run (session).",
);

// Summon / subagent latency instruments — root-cause the 20s+ summon.
//
// A blocking summon stacks cold starts in series: fork the action worker →
// acquire a fresh agent session → spawn the provider CLI subprocess → uncached
// first token. The four instruments below split that envelope so a trace/
// dashboard names the dominant phase instead of leaving it inside the gaps
// between the existing `action:* → summon:* → agent:* → model.turn` spans.

export const actionWorkerStartupMetric = lazyDurationHistogram(
  "rome.action.worker.startup",
  "Elapsed from the parent's fork() to the action worker running its body " +
    "(the Node/tsx cold-start cost), labelled by action.",
);

export const sessionAcquireMetric = lazyCounter(
  "rome.session.acquire",
  'Agent-session acquire outcomes, labelled by outcome ("reuse"|"cold"|' +
    '"reopen"|"coalesced"), agent, and is_subagent. A high cold rate for ' +
    "subagents means the keep-alive cache is being defeated by a fresh key.",
);

export const modelSessionOpenMetric = lazyDurationHistogram(
  "rome.model.session.open",
  "Duration of ModelProvider.openSession() — the provider CLI subprocess " +
    "spawn + tool-catalog/system-prompt assembly, labelled by provider and resumed.",
);

export const modelTurnTtftMetric = lazyDurationHistogram(
  "rome.model.turn.ttft",
  "Time from turn start to the first streamed event (time-to-first-token), " +
    "labelled by model id and is_subagent.",
);

export const modelPromptCacheMetric = lazyCounter(
  "rome.model.prompt.cache",
  'Prompt-cache outcome per turn ("hit" when cache_read_input_tokens > 0, ' +
    'else "miss"), labelled by model id and is_subagent.',
);

/**
 * Record the action-worker cold-start as both a `worker.startup` span (nested
 * under the parent action trace via the already-restored context) and the
 * `rome.action.worker.startup` histogram. Called from the worker process right
 * after telemetry init, before the action body runs. `forkStartedAt` is the
 * epoch-ms the parent stamped just before `child.send()`; when absent (older
 * payload) we no-op the timing but still open a zero-width span for continuity.
 */
export function recordActionWorkerStartup(
  forkStartedAt: number | undefined,
  actionName: string,
  nowMs: number,
): void {
  if (forkStartedAt === undefined) return;
  const durationMs = Math.max(0, nowMs - forkStartedAt);
  actionWorkerStartupMetric().record(durationMs, { "action.name": actionName });
  // Anchor the span to the true fork instant so the waterfall shows the gap
  // between the parent's `action:*` span and the first body work.
  const span = getTracer("rome").startSpan("worker.startup", {
    attributes: { "action.name": actionName, "worker.startup_ms": durationMs },
    startTime: forkStartedAt,
  });
  span.end(nowMs);
}
