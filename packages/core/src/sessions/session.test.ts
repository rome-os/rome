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
    expect(session.providerThreadId).toBeNull();
    expect(session.model).toBeNull();
    expect(session.workingDir).toBe("/w");
    expect(session.deprecatedChatId).toBeNull();
  });

  it("create() has no continuity key unless one is given", () => {
    expect(Session.create("main").continuityKey).toBeNull();
  });

  it("create() takes a fork's own id only through the deprecated option", () => {
    expect(Session.create("main", { deprecatedId: "fork-1" }).id).toBe("fork-1");
  });

  it("recordTurn() writes provider, thread and model together", () => {
    const session = Session.create("main");
    session.recordTurn({ provider: "openai", providerThreadId: "t-1", model: "gpt-5" });
    expect(session.provider).toBe("openai");
    expect(session.providerThreadId).toBe("t-1");
    expect(session.model).toBe("gpt-5");

    // A provider with no thread yet clears the stale thread and model, so a
    // resume never replays another provider's thread.
    session.recordTurn({ provider: "anthropic" });
    expect(session.provider).toBe("anthropic");
    expect(session.providerThreadId).toBeNull();
    expect(session.model).toBeNull();
  });

  it("recordTurn() keeps the reasoning effort when a turn reports none", () => {
    const session = Session.create("main");
    session.recordTurn({ provider: "openai", reasoningEffort: "xhigh" });
    session.recordTurn({ provider: "openai" });
    expect(session.reasoningEffort).toBe("xhigh");
  });

  it("recordTurn() hands the checkpoint to the repository, and only with a thread", () => {
    const session = Session.create("main");
    session.recordTurn({ provider: "openai", checkpoint: { turnId: "turn-1", checkpointId: "c" } });
    expect(session.pendingChanges().checkpoint).toBeUndefined();

    session.recordTurn({
      provider: "openai",
      providerThreadId: "t-1",
      checkpoint: { turnId: "turn-2", checkpointId: "c-2" },
    });
    expect(session.pendingChanges().checkpoint).toEqual({
      sessionId: session.id,
      turnId: "turn-2",
      provider: "openai",
      providerThreadId: "t-1",
      checkpointId: "c-2",
    });
    session.markSaved();
    expect(session.pendingChanges().checkpoint).toBeUndefined();
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

  it("deprecatedHasProviderThread follows the provider thread", () => {
    const session = Session.create("main");
    expect(session.deprecatedHasProviderThread).toBe(false);
    session.recordTurn({ provider: "openai", providerThreadId: "t-1" });
    expect(session.deprecatedHasProviderThread).toBe(true);
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
      deprecatedChatId: "chat-1",
    });
    session.recordTurn({ provider: "openai", providerThreadId: "t-1", model: "gpt-5" });

    const successor = session.replace();
    expect(session.status).toBe("completed");
    expect(successor.id).not.toBe(session.id);
    expect(successor.status).toBe("active");
    expect(successor.agentName).toBe("main");
    expect(successor.continuityKey).toBe("webchat:chat-1");
    expect(successor.provider).toBeNull();
    expect(successor.providerThreadId).toBeNull();
    expect(successor.model).toBeNull();
    // The working dir is the provider's, so the successor starts without one
    // until it opens, as a reset does today.
    expect(successor.workingDir).toBeNull();
    expect(successor.deprecatedChatId).toBe("chat-1");
  });

  it("replace() takes the chat named over the one carried over", () => {
    const session = Session.create("main", { continuityKey: "k", deprecatedChatId: "chat-1" });
    expect(session.replace({ deprecatedChatId: "chat-2" }).deprecatedChatId).toBe("chat-2");
  });

  it("deprecatedRecordChat() fills a missing chat and never overwrites one", () => {
    const session = Session.create("main");
    expect(session.deprecatedRecordChat("chat-1")).toBe(true);
    expect(session.deprecatedRecordChat("chat-2")).toBe(false);
    expect(session.deprecatedChatId).toBe("chat-1");
  });

  it("snapshot() is a copy, so a later change is not seen through it", () => {
    const session = Session.create("main");
    const before = session.snapshot();
    session.moveTo("/elsewhere");
    expect(before.workingDir).toBeNull();
    expect(session.workingDir).toBe("/elsewhere");
  });
});
