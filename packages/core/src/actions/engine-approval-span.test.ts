import { afterEach, beforeEach, expect, it } from "@rstest/core";
import { trace } from "@opentelemetry/api";
import { installTestSpanHarness, type SpanHarness } from "../test/helpers.js";
import { createTestRome, buildAction, type TestRome } from "../test/kit/index.js";

// Approval-span telemetry through the real wiring (testkit): the traced
// production engine over real repos. The span assertions are coupled to the
// behavior they advertise — the pending approval row and the parked execution
// row are read back from the DB alongside the span.

let harness: SpanHarness;
let rome: TestRome;

beforeEach(() => {
  harness = installTestSpanHarness("basic");
});

afterEach(async () => {
  await rome?.cleanup();
  await harness.shutdown();
});

it("stamps rome.action.approval_required=true and emits approval_required event when the action pauses for approval", async () => {
  rome = await createTestRome({
    actions: [
      buildAction("risky", {
        description: "needs approval",
        sideEffects: "write",
        requiresApproval: true,
      }),
    ],
    engine: { tracer: trace.getTracer("rome-test") },
  });

  const result = await rome.actionEngine.run("risky", { target: "prod" });

  // The behavior the span advertises: a pending approval row gates the run...
  if (result.status !== "pending_approval") {
    throw new Error(`expected pending_approval, got ${result.status}`);
  }
  const approval = await rome.repos.approvals.findById(result.approval.approvalId);
  expect(approval).toMatchObject({ type: "action_execution", status: "pending" });
  expect(approval!.payload).toMatchObject({ actionName: "risky", args: { target: "prod" } });

  // ...and the execution row is parked, not finished.
  const [execution] = await rome.repos.actionExecutions.findByAction("risky");
  expect(execution).toMatchObject({ status: "pending_approval" });
  expect(execution.finishedAt).toBeNull();

  // The telemetry mirrors that state.
  const spans = await harness.finishedSpans();
  const actionSpan = spans.find((s) => s.name === "action:risky");
  expect(actionSpan, "action:risky span missing").toBeDefined();
  expect(actionSpan!.attributes["rome.action.approval_required"]).toBe(true);
  const event = actionSpan!.events.find((e) => e.name === "approval_required");
  expect(event).toBeDefined();
  expect(event!.attributes?.["action.name"]).toBe("risky");
});
