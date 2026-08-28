/**
 * Drives one inbound message through the same composition-root wiring Rome
 * uses in production (see `buildGoldenTraceRig`) and asserts the expected
 * span hierarchy:
 *
 *     channel:<channel>.handle
 *       └── hook:channel-message
 *             └── agent:<name>
 *                   ├── model.turn
 *                   └── action:<name>
 *
 * The instrumentation lives at the neutral ProviderAdapter / ModelProvider
 * boundaries so any adapter or provider impl produces these spans uniformly;
 * the EXPECT_*_SPAN gates remain as dials in case a future migration wants
 * to soften an assertion.
 */

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { buildMessage, installTestSpanHarness, type SpanHarness } from "./helpers.js";
import {
  buildGoldenTraceRig,
  makeSingleActionProvider,
  type GoldenTraceRig,
} from "./golden-trace-harness.js";

const EXPECT_CHANNEL_SPAN = true;
const EXPECT_HOOK_SPAN = true;
const EXPECT_AGENT_SPAN = true;
const EXPECT_MODEL_SPAN = true;
const EXPECT_ACTION_SPAN = true;

function checkSpan(
  spans: ReadableSpan[],
  label: string,
  gate: boolean,
  predicate: (s: ReadableSpan) => boolean,
): ReadableSpan | undefined {
  const span = spans.find(predicate);
  if (gate) {
    expect(
      span,
      `${label} span missing. Captured: ${spans.map((s) => s.name).join(", ")}`,
    ).toBeDefined();
  }
  return span;
}

function assertChildOf(child: ReadableSpan, parent: ReadableSpan): void {
  expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
}

describe("golden-trace integration", () => {
  let harness: SpanHarness;
  let rig: GoldenTraceRig;

  beforeEach(async () => {
    // `node` kind is required: parent-child links must survive awaits across
    // the channel→hook→agent→model chain that yields through generators.
    harness = installTestSpanHarness("node");
    rig = await buildGoldenTraceRig({
      modelProvider: makeSingleActionProvider("demo_action", { name: "standup" }),
      channels: ["telegram"],
      agentName: "test-main",
      tracer: trace.getTracer("rome-test"),
      extraActions: [
        {
          config: {
            name: "demo_action",
            type: "system",
            description: "Schedule an event",
            complexity: "simple",
            speed: "fast",
            reliability: "high",
            sideEffects: "write",
          },
          inputSchema: {},
          execute: async () => ({ status: "ok", data: "ok" }),
        },
      ],
    });
  });

  afterEach(async () => {
    rig.shutdown();
    await harness.shutdown();
  });

  it("emits the expected span hierarchy for one inbound message", async () => {
    await rig.simulateInbound(
      "telegram",
      buildMessage({ channel: "telegram", threadId: "thread-golden", text: "hi" }),
    );

    const spans = await harness.finishedSpans();

    const channelSpan = checkSpan(spans, "channel:*.handle", EXPECT_CHANNEL_SPAN, (s) =>
      /^channel:.+\.handle$/u.test(s.name),
    );
    const hookSpan = checkSpan(
      spans,
      "hook:channel-message",
      EXPECT_HOOK_SPAN,
      (s) => s.name === "hook:channel-message",
    );
    const agentSpan = checkSpan(spans, "agent:*", EXPECT_AGENT_SPAN, (s) =>
      s.name.startsWith("agent:"),
    );
    const modelSpan = checkSpan(
      spans,
      "model.turn",
      EXPECT_MODEL_SPAN,
      (s) => s.name === "model.turn",
    );
    const actionSpan = checkSpan(spans, "action:*", EXPECT_ACTION_SPAN, (s) =>
      s.name.startsWith("action:"),
    );

    if (EXPECT_ACTION_SPAN) {
      expect(actionSpan!.name).toBe("action:demo_action");
    }

    if (channelSpan && hookSpan) assertChildOf(hookSpan, channelSpan);
    if (hookSpan && agentSpan) assertChildOf(agentSpan, hookSpan);
    if (agentSpan && modelSpan) assertChildOf(modelSpan, agentSpan);
    if (agentSpan && actionSpan) assertChildOf(actionSpan, agentSpan);
  });

  it("stamps model.turn with accounting attrs from the terminal result message", async () => {
    await rig.simulateInbound("telegram", buildMessage({ channel: "telegram", text: "hi" }));

    const spans = await harness.finishedSpans();
    const modelSpan = spans.find((s) => s.name === "model.turn");
    expect(modelSpan).toBeDefined();
    expect(modelSpan!.attributes["input_tokens"]).toBe(10);
    expect(modelSpan!.attributes["output_tokens"]).toBe(20);
    expect(modelSpan!.attributes["estimated_cost_usd"]).toBe(0.001);
    expect(modelSpan!.attributes["stop_reason"]).toBe("end_turn");
    expect(modelSpan!.attributes["num_turns"]).toBe(1);
  });
});
