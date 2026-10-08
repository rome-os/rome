import { describe, expect, it } from "@rstest/core";
import { decodeAppIdPathSegment, toTraceEvent } from "./helpers.js";

describe("decodeAppIdPathSegment", () => {
  it("decodes a complete scoped app id from one route segment", () => {
    expect(decodeAppIdPathSegment("%40foo%2Fbar")).toBe("@foo/bar");
  });

  it("rejects a slash that is not a valid scoped app id", () => {
    expect(() => decodeAppIdPathSegment("foo%2Fbar")).toThrow(/Invalid app id route segment/);
  });
});

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

  it("preserves provider block ids on durable text and thinking blocks", () => {
    expect(toTraceEvent({ type: "text", content: "hello", blockId: "text-1" })).toMatchObject({
      type: "text",
      blockId: "text-1",
    });
    expect(toTraceEvent({ type: "thinking", content: "plan", blockId: "think-1" })).toMatchObject({
      type: "thinking",
      blockId: "think-1",
    });
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
