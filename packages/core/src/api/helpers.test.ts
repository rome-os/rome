import { describe, expect, it } from "@rstest/core";
import { decodeAppIdPathSegment, toTraceEvent, toWebchatSessionResponse } from "./helpers.js";

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

describe("a pinned chat always reports it is pinned, in the chat API", () => {
  const chat = {
    id: "c1",
    name: "Chat",
    personaId: null,
    projectName: "default",
    createdAt: new Date("2026-11-22T00:00:00.000Z"),
    activityAt: new Date("2026-11-22T00:00:00.000Z"),
  };

  it("adds followsDefault and pinnedModel beside the fields the iOS app reads", () => {
    expect(
      toWebchatSessionResponse(
        { ...chat, largeModelSelection: "claude-haiku", largeModelSelectionBy: "owner" },
        0,
      ),
    ).toMatchObject({
      largeModelSelection: "claude-haiku",
      followsDefault: false,
      pinnedModel: { by: "owner", providerId: "anthropic", selection: "claude-haiku" },
    });
  });

  it("reports a chat held on a provider with no model of its own, such as a fork", () => {
    expect(
      toWebchatSessionResponse({ ...chat, largeModelSelection: null }, 0, "openai"),
    ).toMatchObject({
      followsDefault: false,
      pinnedModel: { by: "kept", providerId: "openai", selection: null, model: null },
    });
  });

  it("reports nothing pinned for a model Rome chose", () => {
    expect(
      toWebchatSessionResponse(
        { ...chat, largeModelSelection: "claude-opus-5-5", largeModelSelectionBy: "auto" },
        0,
      ),
    ).toMatchObject({ followsDefault: true, pinnedModel: null });
  });
});
