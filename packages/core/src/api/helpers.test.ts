import { describe, expect, it } from "@rstest/core";
import { decodeAppIdPathSegment, toTraceBlock } from "./helpers.js";

describe("decodeAppIdPathSegment", () => {
  it("decodes a complete scoped app id from one route segment", () => {
    expect(decodeAppIdPathSegment("%40foo%2Fbar")).toBe("@foo/bar");
  });

  it("rejects a slash that is not a valid scoped app id", () => {
    expect(() => decodeAppIdPathSegment("foo%2Fbar")).toThrow(/Invalid app id route segment/);
  });
});

describe("toTraceBlock", () => {
  it("preserves an opaque Rome session reference on session_init", () => {
    expect(
      toTraceBlock({
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
    expect(toTraceBlock({ type: "session_init", sessionId: "runtime-session" })).toMatchObject({
      type: "session_init",
      sessionId: "runtime-session",
      romeSession: undefined,
    });
  });

  it("maps provider-neutral plan updates to durable trace blocks", () => {
    expect(
      toTraceBlock({
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
