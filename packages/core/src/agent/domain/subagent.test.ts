import { describe, expect, it } from "@rstest/core";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import {
  refuseResume,
  storedAgentName,
  SubagentOutcomeReader,
  subagentRequest,
  subagentSessionName,
  type StoredSubagentSession,
} from "./subagent.js";

describe("subagentRequest", () => {
  it("reads the prompt and the session to resume", () => {
    expect(subagentRequest({ prompt: "go", resumeSessionId: "s1" })).toEqual({
      prompt: "go",
      resumeSessionId: "s1",
    });
    expect(subagentRequest({ prompt: "go" })).toEqual({ prompt: "go" });
  });

  it.each([
    [undefined],
    [{}],
    [{ prompt: "" }],
    [{ prompt: 3 }],
  ])("refuses %j, which has no prompt", (input) => {
    expect(() => subagentRequest(input)).toThrow("execute_subagent requires a non-empty prompt");
  });
});

describe("refuseResume", () => {
  const call = { subagent: "core:helper", parentRecordId: "parent", resumeSessionId: "child" };
  const stored: StoredSubagentSession = {
    type: "subagent",
    agentName: "core:helper",
    parentSessionId: "parent",
    projectPath: "/p",
  };
  const parent = { projectPath: "/p" };

  it("lets a resume continue a session the same parent started for the same subagent in its project", () => {
    expect(refuseResume(stored, parent, call)).toBeNull();
  });

  it("refuses when the parent record is missing", () => {
    expect(refuseResume(stored, null, call)).toBe('Parent Rome session "parent" was not found');
  });

  it("refuses a missing session and one that is not a subagent's", () => {
    expect(refuseResume(null, parent, call)).toBe('Subagent session "child" was not found');
    expect(refuseResume({ ...stored, type: "fork" }, parent, call)).toBe(
      'Subagent session "child" was not found',
    );
  });

  it("refuses another subagent's session", () => {
    expect(refuseResume({ ...stored, agentName: "core:other" }, parent, call)).toBe(
      'Subagent session "child" belongs to agent "core:other", not "core:helper"',
    );
  });

  it("reads a missing agent name as main, so a core main session never resumes as core:main", () => {
    expect(refuseResume({ ...stored, agentName: null }, parent, call)).toContain(
      'belongs to agent "main"',
    );
    expect(
      refuseResume({ ...stored, agentName: null }, parent, { ...call, subagent: "core:main" }),
    ).toBe('Subagent session "child" belongs to agent "main", not "core:main"');
  });

  it("refuses another parent's session", () => {
    expect(refuseResume({ ...stored, parentSessionId: "other" }, parent, call)).toBe(
      'Subagent session "child" belongs to a different Parent session',
    );
  });

  it("refuses a session in another project than the parent's", () => {
    expect(refuseResume(stored, { projectPath: "/q" }, call)).toBe(
      'Subagent session "child" belongs to a different project',
    );
    expect(refuseResume({ ...stored, projectPath: null }, { projectPath: null }, call)).toBeNull();
  });
});

describe("a subagent session's record", () => {
  it("is named after the subagent and the parent record, or the parent's agent", () => {
    expect(subagentSessionName("core:helper", "Trip plan", "core:main")).toBe(
      "core:helper: Trip plan",
    );
    expect(subagentSessionName("core:helper", null, "core:main")).toBe("core:helper: core:main");
  });

  it("stores no agent name for the core main agent", () => {
    expect(storedAgentName("core:main")).toBeNull();
    expect(storedAgentName("core:helper")).toBe("core:helper");
  });
});

describe("SubagentOutcomeReader", () => {
  const fold = (events: StreamAgentEvent[]) => {
    const reader = new SubagentOutcomeReader();
    for (const event of events) reader.read(event);
    return reader.outcome();
  };
  const result = (content: string, extra: object = {}) =>
    ({ type: "result", content, ...extra }) as unknown as StreamAgentEvent;
  const error = (message: string, code?: string) =>
    ({ type: "error", error: message, ...(code ? { code } : {}) }) as unknown as StreamAgentEvent;
  const turnEnd = (status: string) => ({ type: "turn_end", status }) as unknown as StreamAgentEvent;

  it("completes with the result text", () => {
    expect(fold([result("done"), turnEnd("completed")])).toEqual({
      status: "completed",
      output: "done",
    });
  });

  it("completes with the structured output when the turn has one, even when it is undefined", () => {
    expect(fold([result("done", { structuredOutput: { a: 1 } })])).toEqual({
      status: "completed",
      output: { a: 1 },
    });
    expect(fold([result("done", { structuredOutput: undefined })])).toEqual({
      status: "completed",
      output: undefined,
    });
  });

  it("fails on an error event, with its code", () => {
    expect(fold([error("boom", "auth_revoked")])).toEqual({
      status: "failed",
      error: { message: "boom", code: "auth_revoked" },
    });
  });

  it("is cancelled when the turn ended interrupted, whatever else it saw", () => {
    expect(fold([turnEnd("interrupted")])).toEqual({
      status: "cancelled",
      error: { message: "Subagent execution was cancelled" },
    });
    expect(fold([error("stopped"), turnEnd("interrupted")])).toEqual({
      status: "cancelled",
      error: { message: "stopped" },
    });
  });

  it("completes with empty text when the turn gave no result", () => {
    expect(fold([])).toEqual({ status: "completed", output: "" });
  });
});
