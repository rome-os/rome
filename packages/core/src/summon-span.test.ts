import { afterEach, beforeEach, expect, it } from "@rstest/core";
import { createSummonAction } from "../../../rome_apps/system/src/actions/summon/index.js";
import {
  clearTestTelemetryBridge,
  installTestSpanHarness,
  installTestTelemetryBridge,
  type SpanHarness,
} from "./test/helpers.js";
import type { AgentRunner } from "./core/agent-runner.js";

const actionConfig = {
  name: "summon",
  type: "system",
  description: "Summon subagent",
  complexity: "complex",
  speed: "slow",
  reliability: "medium",
  sideEffects: "write",
} as const;

let harness: SpanHarness;

beforeEach(() => {
  harness = installTestSpanHarness("node");
  installTestTelemetryBridge();
});

afterEach(async () => {
  clearTestTelemetryBridge();
  await harness.shutdown();
});

it("emits summon:<agent> span stamped with rome.summon.child_agent", async () => {
  const runner = {
    async *run() {
      yield {
        type: "session_init" as const,
        sessionId: "sess-1",
        romeSession: { _romeSessionId: "action:exec-1:researcher", _type: "action" },
      };
      yield { type: "result" as const, content: "done" };
    },
  } as unknown as AgentRunner;

  const tool = createSummonAction(actionConfig, {
    agentRunner: runner,
    resolveArtifactReference: ({ value }) => value,
  });
  await tool.execute({ agentName: "researcher", prompt: "find prior art" });

  const spans = await harness.finishedSpans();
  const summonSpan = spans.find((s) => s.name === "summon:researcher");
  expect(summonSpan, "summon:researcher span missing").toBeDefined();
  expect(summonSpan!.attributes["rome.summon.child_agent"]).toBe("researcher");
});
