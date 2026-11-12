import { describe, expect, it } from "@rstest/core";
import { toTraceEvent } from "./helpers.js";

describe("toTraceEvent", () => {
  it("keeps a tool result's isError flag, including false", () => {
    for (const isError of [true, false]) {
      expect(
        toTraceEvent({ type: "tool_result", toolUseId: "t1", tool: "Bash", output: "x", isError }),
      ).toMatchObject({ type: "tool_result", toolUseId: "t1", isError });
    }
    expect(
      toTraceEvent({ type: "tool_result", toolUseId: "t1", tool: "Bash", output: "x" }),
    ).not.toHaveProperty("isError");
  });

  it("keeps the session renewal a turn_start announces, and adds none to another", () => {
    const start = { type: "turn_start" as const, turnId: "t1", sessionId: "s2", userPrompt: "hi" };
    expect(
      toTraceEvent({ ...start, sessionRenewal: { reason: "setup", sessionId: "s2" } }),
    ).toMatchObject({ sessionRenewal: { reason: "setup", sessionId: "s2" } });
    expect(toTraceEvent(start)).not.toHaveProperty("sessionRenewal");
  });

  it("preserves an opaque Rome session reference on session_init", () => {
    expect(
      toTraceEvent({
        type: "session_init",
        sessionId: "runtime-session",
        romeSession: { _romeSessionId: "action:execution-1:reviewer", _type: "action" },
        agent: "reviewer",
      }),
    ).toEqual({
      type: "session_init",
      sessionId: "runtime-session",
      romeSession: { _romeSessionId: "action:execution-1:reviewer", _type: "action" },
      systemPrompt: undefined,
      userPrompt: undefined,
      projectPath: undefined,
      agent: "reviewer",
    });
  });

  it("keeps legacy session_init blocks valid without a Rome reference", () => {
    expect(toTraceEvent({ type: "session_init", sessionId: "runtime-session" })).toMatchObject({
      type: "session_init",
      sessionId: "runtime-session",
      romeSession: undefined,
    });
  });

  it("maps provider-neutral plan updates to durable trace blocks", () => {
    expect(
      toTraceEvent({
        type: "plan_update",
        plan: {
          explanation: "Working through the request",
          steps: [
            { text: "Inspect the provider", status: "completed" },
            { text: "Render the plan", activeText: "Rendering the plan", status: "in_progress" },
          ],
        },
      }),
    ).toEqual({
      type: "plan_update",
      plan: {
        explanation: "Working through the request",
        steps: [
          { text: "Inspect the provider", status: "completed" },
          { text: "Render the plan", activeText: "Rendering the plan", status: "in_progress" },
        ],
      },
      agent: undefined,
    });
  });
});
