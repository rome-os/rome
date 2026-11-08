import { describe, expect, it } from "@rstest/core";
import { Session } from "./session.js";

describe("Session", () => {
  it("create() mints the id and starts active on no provider", () => {
    const session = Session.create("main", { continuityKey: "webchat:chat-1", workingDir: "/w" });
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.agentName).toBe("main");
    expect(session.continuityKey).toBe("webchat:chat-1");
    expect(session.status).toBe("active");
    expect(session.provider).toBeNull();
    expect(session.modelThreadId).toBeNull();
    expect(session.model).toBeNull();
    expect(session.workingDir).toBe("/w");
  });

  it("create() has no continuity key unless one is given", () => {
    expect(Session.create("main").continuityKey).toBeNull();
  });

  it("create() takes a fork's own id only through the deprecated option", () => {
    expect(Session.create("main", { deprecatedId: "fork-1" }).id).toBe("fork-1");
  });

  it("recordTurn() writes provider, thread and model together", () => {
    const session = Session.create("main");
    session.recordTurn({ provider: "openai", modelThreadId: "t-1", model: "gpt-5" });
    expect(session.provider).toBe("openai");
    expect(session.modelThreadId).toBe("t-1");
    expect(session.model).toBe("gpt-5");

    // A provider with no thread yet clears the stale thread and model, so a
    // resume never replays another provider's thread.
    session.recordTurn({ provider: "anthropic" });
    expect(session.provider).toBe("anthropic");
    expect(session.modelThreadId).toBeNull();
    expect(session.model).toBeNull();
  });

  it("recordTurn() keeps the reasoning effort when a turn reports none", () => {
    const session = Session.create("main");
    session.recordTurn({ provider: "openai", reasoningEffort: "xhigh" });
    session.recordTurn({ provider: "openai" });
    expect(session.reasoningEffort).toBe("xhigh");
  });

  it("recordTurn() hands each turn's checkpoint to the repository, and only with a thread", () => {
    const session = Session.create("main");
    session.recordTurn({ provider: "openai", checkpoint: { turnId: "turn-1", checkpointId: "c" } });
    expect(session.pendingChanges().checkpoints).toEqual([]);

    session.recordTurn({
      provider: "openai",
      modelThreadId: "t-1",
      checkpoint: { turnId: "turn-2", checkpointId: "c-2" },
    });
    session.recordTurn({
      provider: "openai",
      modelThreadId: "t-1",
      checkpoint: { turnId: "turn-3", checkpointId: "c-3" },
    });
    expect(session.pendingChanges().checkpoints).toEqual([
      {
        sessionId: session.id,
        turnId: "turn-2",
        provider: "openai",
        modelThreadId: "t-1",
        checkpointId: "c-2",
      },
      {
        sessionId: session.id,
        turnId: "turn-3",
        provider: "openai",
        modelThreadId: "t-1",
        checkpointId: "c-3",
      },
    ]);
    session.markSaved();
    expect(session.pendingChanges().checkpoints).toEqual([]);
  });

  it("tracks which facts changed since the last save", () => {
    const session = Session.create("main");
    expect([...session.pendingChanges().changes]).toEqual([]);
    session.recordTurn({ provider: "openai", reasoningEffort: "high" });
    session.moveTo("/w");
    expect([...session.pendingChanges().changes].sort()).toEqual([
      "reasoningEffort",
      "turn",
      "workingDir",
    ]);
    session.markSaved();
    session.touch();
    expect([...session.pendingChanges().changes]).toEqual(["lastActiveAt"]);
    session.complete();
    expect([...session.pendingChanges().changes].sort()).toEqual(["lastActiveAt", "status"]);
  });

  it("deprecatedHasModelThread follows the model thread", () => {
    const session = Session.create("main");
    expect(session.deprecatedHasModelThread).toBe(false);
    session.recordTurn({ provider: "openai", modelThreadId: "t-1" });
    expect(session.deprecatedHasModelThread).toBe(true);
  });

  it("touch() and complete() move lastActiveAt forward", () => {
    const session = Session.create("main");
    const born = session.lastActiveAt.getTime();
    session.touch();
    expect(session.lastActiveAt.getTime()).toBeGreaterThanOrEqual(born);
    session.complete();
    expect(session.status).toBe("completed");
    expect(session.lastActiveAt.getTime()).toBeGreaterThanOrEqual(born);
  });

  it("replace() completes the session and returns a successor on no provider", () => {
    const session = Session.create("main", {
      continuityKey: "webchat:chat-1",
      workingDir: "/w",
    });
    session.recordTurn({ provider: "openai", modelThreadId: "t-1", model: "gpt-5" });

    const successor = session.replace();
    expect(session.status).toBe("completed");
    expect(successor.id).not.toBe(session.id);
    expect(successor.status).toBe("active");
    expect(successor.agentName).toBe("main");
    expect(successor.continuityKey).toBe("webchat:chat-1");
    expect(successor.provider).toBeNull();
    expect(successor.modelThreadId).toBeNull();
    expect(successor.model).toBeNull();
    // The working dir is the provider's, so the successor starts without one
    // until it opens, as a reset does today.
    expect(successor.workingDir).toBeNull();
  });

  it("snapshot() is a copy, so a later change is not seen through it", () => {
    const session = Session.create("main");
    const before = session.snapshot();
    session.moveTo("/elsewhere");
    expect(before.workingDir).toBeNull();
    expect(session.workingDir).toBe("/elsewhere");
  });
});
