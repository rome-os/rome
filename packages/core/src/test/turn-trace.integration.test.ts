/**
 * Direct `sendTurn` path (webchat-style, no channel adapter): the turn
 * span is the trace root and post-turn work wrapped in `handle.turnContext`
 * parents under it. Complements `golden-trace.integration.test.ts`, which
 * covers the channel-adapter path.
 */

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { context, trace, type Context, type SpanContext } from "@opentelemetry/api";

import { installTestSpanHarness, type SpanHarness } from "./helpers.js";
import {
  buildGoldenTraceRig,
  makeSingleActionProvider,
  type GoldenTraceRig,
} from "./golden-trace-harness.js";

async function drainOneTurn(
  rig: GoldenTraceRig,
  opts?: { linkFromSpanContext?: SpanContext },
): Promise<{ turnContext: Context }> {
  const session = await rig.manager.acquire(
    { agentName: "test-main", channelThreadKey: "webchat:turn-trace-test" },
    { workingDir: "/tmp" },
  );

  const handle = session.sendTurn(
    { prompt: "hi" },
    opts?.linkFromSpanContext ? { links: [{ context: opts.linkFromSpanContext }] } : undefined,
  );
  for await (const _ of handle.events) {
    // drain
  }
  return { turnContext: handle.turnContext };
}

describe("turn-scoped tracing (direct sendTurn)", () => {
  let harness: SpanHarness;
  let rig: GoldenTraceRig;

  beforeEach(async () => {
    harness = installTestSpanHarness("node");
    rig = await buildGoldenTraceRig({
      modelProvider: makeSingleActionProvider("demo_action", { name: "standup" }),
      channels: [],
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

  it("turn span is the trace root when sendTurn has no enclosing context", async () => {
    await drainOneTurn(rig);
    const spans = await harness.finishedSpans();

    const agent = spans.find((s) => s.name.startsWith("agent:"));
    const model = spans.find((s) => s.name === "model.turn");
    const action = spans.find((s) => s.name.startsWith("action:"));

    expect(
      agent,
      `agent span missing. Captured: ${spans.map((s) => s.name).join(", ")}`,
    ).toBeDefined();
    expect(model).toBeDefined();
    expect(action).toBeDefined();

    expect(agent!.parentSpanContext, "agent span must be a trace root").toBeUndefined();
    expect(model!.spanContext().traceId).toBe(agent!.spanContext().traceId);
    expect(action!.spanContext().traceId).toBe(agent!.spanContext().traceId);
  });

  it("records caller-supplied links on the turn root", async () => {
    const callerTracer = trace.getTracer("caller");
    const callerSpan = callerTracer.startSpan("POST /chat/send");
    const callerCtx = callerSpan.spanContext();
    callerSpan.end();

    await drainOneTurn(rig, { linkFromSpanContext: callerCtx });
    const spans = await harness.finishedSpans();

    const agent = spans.find((s) => s.name.startsWith("agent:"))!;
    expect(agent.links.length).toBe(1);
    expect(agent.links[0].context.traceId).toBe(callerCtx.traceId);
    expect(agent.links[0].context.spanId).toBe(callerCtx.spanId);
    // The agent span is still a root — links are not parents.
    expect(agent.parentSpanContext).toBeUndefined();
  });

  it("every span in the turn carries channel.thread_key and channel.name", async () => {
    await drainOneTurn(rig);
    const spans = await harness.finishedSpans();

    const agent = spans.find((s) => s.name.startsWith("agent:"))!;
    const model = spans.find((s) => s.name === "model.turn")!;
    const action = spans.find((s) => s.name.startsWith("action:"))!;

    const expectedThreadKey = "webchat:turn-trace-test";
    for (const span of [agent, model, action]) {
      expect(span.attributes["channel.thread_key"], `${span.name} missing channel.thread_key`).toBe(
        expectedThreadKey,
      );
      expect(span.attributes["channel.name"], `${span.name} missing channel.name`).toBe("webchat");
      expect(span.attributes["turn.id"], `${span.name} missing turn.id`).toBeDefined();
    }
  });

  it("handle.turnContext lets external work parent under the same trace", async () => {
    const { turnContext } = await drainOneTurn(rig);

    // Simulate post-turn work that happens outside any active span. With
    // turnContext, downstream spans must still land on the agent trace.
    const tracer = trace.getTracer("post-turn");
    await context.with(turnContext, async () => {
      const span = tracer.startSpan("channel:webchat.send");
      span.end();
    });

    const spans = await harness.finishedSpans();
    const agent = spans.find((s) => s.name.startsWith("agent:"))!;
    const postTurn = spans.find((s) => s.name === "channel:webchat.send")!;
    expect(postTurn.spanContext().traceId).toBe(agent.spanContext().traceId);
    expect(postTurn.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
  });
});
