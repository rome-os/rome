import { describe, it, expect, rs } from "@rstest/core";
import type { ActionResult, ChildSessionStatusReport } from "@rome-os/app-runtime";
import { createSummonStatusAction } from "./index.js";

const actionConfig = {
  name: "summon_status",
  type: "system",
  description: "Read a detached summon's child session",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
} as const;

function report(overrides: Partial<ChildSessionStatusReport> = {}): ChildSessionStatusReport {
  return {
    sessionId: "child-1",
    agentName: "coder",
    parentSessionId: "parent-1",
    status: "completed",
    turnId: "child-turn-1",
    startedAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:05:00.000Z",
    reply: "the migration landed",
    error: null,
    ...overrides,
  };
}

function makeTool(getStatus: ReturnType<typeof rs.fn>) {
  return createSummonStatusAction(actionConfig, {
    childSessions: { startDetached: rs.fn(), getStatus, stop: rs.fn() },
  });
}

describe("summon_status", () => {
  it.each([
    "running",
    "completed",
    "failed",
    "interrupted",
    "unknown",
  ] as const)("passes a %s report straight through", async (status) => {
    const getStatus = rs.fn(async () => report({ status }));
    const result = await makeTool(getStatus).execute({ sessionId: "child-1" });

    expect(result).toEqual({ status: "ok", data: report({ status }) });
    expect(getStatus).toHaveBeenCalledWith({ sessionId: "child-1", transcriptTail: undefined });
  });

  it("reports not_found for an id no session carries", async () => {
    // Distinct from a session that exists but has run no turn, which is
    // `unknown` — an agent polling a bad id must not read it as "still warming
    // up" and keep polling forever.
    const getStatus = rs.fn(async () => null);

    const result = await makeTool(getStatus).execute({ sessionId: "nope" });

    expect(result).toEqual({
      status: "ok",
      data: { status: "not_found", sessionId: "nope" },
    });
  });

  it("forwards a requested transcript tail and returns the transcript", async () => {
    const transcript = [
      {
        role: "user" as const,
        turnId: "child-turn-1",
        text: "go",
        createdAt: "2030-01-01T00:00:00.000Z",
      },
      {
        role: "assistant" as const,
        turnId: "child-turn-1",
        text: "done",
        createdAt: "2030-01-01T00:05:00.000Z",
      },
    ];
    const getStatus = rs.fn(async () => report({ transcript }));

    const result = await makeTool(getStatus).execute({
      sessionId: "child-1",
      transcriptTail: 2,
    });

    expect(getStatus).toHaveBeenCalledWith({ sessionId: "child-1", transcriptTail: 2 });
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect((result.data as ChildSessionStatusReport).transcript).toEqual(transcript);
  });

  it.each([
    ["over the ceiling", { sessionId: "child-1", transcriptTail: 51 }],
    ["fractional", { sessionId: "child-1", transcriptTail: 1.5 }],
    ["negative", { sessionId: "child-1", transcriptTail: -1 }],
    ["missing a session id", {}],
  ])("rejects a tail that is %s without reading anything", async (_label, args) => {
    const getStatus = rs.fn();

    const result = (await makeTool(getStatus).execute(args)) as ActionResult;

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/Invalid input/);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("previews the session it will read", () => {
    const payload = makeTool(rs.fn()).preview!({ sessionId: "child-1" });

    expect(payload).toEqual({
      kind: "generic",
      title: "Check a summoned agent",
      summary: "child-1",
    });
  });
});
