import { describe, expect, it, rs } from "@rstest/core";
import type { ActionConfig } from "@rome-os/app-runtime";
import { createResumeSessionAction } from "./index.js";

const config = { name: "resume_session" } as unknown as ActionConfig;

function makeDeps() {
  const runAndDeliver = rs.fn().mockResolvedValue(undefined);
  const deps = { backendTurnRunner: { runAndDeliver } } as never;
  return { deps, runAndDeliver };
}

describe("resume_session dispatcher", () => {
  it("forwards a single runAndDeliver to the orchestrator (no channel branch here)", async () => {
    const { deps, runAndDeliver } = makeDeps();
    const action = createResumeSessionAction(config, deps);

    const result = await action.execute({
      sessionId: "agent-session-tg-9",
      channel: "telegram",
      threadId: "tg-9",
      channelUserId: "u-1",
      agentName: "main",
      text: "⏰ check CI",
    });

    expect(runAndDeliver).toHaveBeenCalledWith({
      agentName: "main",
      sessionId: "agent-session-tg-9",
      channel: "telegram",
      threadId: "tg-9",
      channelUserId: "u-1",
      prompt: "⏰ check CI",
    });
    expect(result.status).toBe("ok");
  });

  it("works the same for webchat — the orchestrator owns the per-channel difference", async () => {
    const { deps, runAndDeliver } = makeDeps();
    const action = createResumeSessionAction(config, deps);

    await action.execute({
      sessionId: "agent-session-1",
      channel: "webchat",
      threadId: "sess-1",
      agentName: "main",
      text: "x",
    });

    expect(runAndDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-1",
        channel: "webchat",
        threadId: "sess-1",
        agentName: "main",
      }),
    );
  });

  it("errors when channel or threadId is missing", async () => {
    const { deps } = makeDeps();
    const action = createResumeSessionAction(config, deps);
    const result = await action.execute({ channel: "webchat" });
    expect(result.status).toBe("error");
  });

  it("reports an orchestrator failure as an action error", async () => {
    const { deps, runAndDeliver } = makeDeps();
    runAndDeliver.mockRejectedValueOnce(new Error("runtime gone"));
    const action = createResumeSessionAction(config, deps);
    const result = await action.execute({
      sessionId: "agent-session-1",
      channel: "webchat",
      threadId: "sess-1",
      agentName: "main",
      text: "x",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("runtime gone");
  });

  it("errors when agentName is missing rather than silently resuming main", async () => {
    const { deps, runAndDeliver } = makeDeps();
    const action = createResumeSessionAction(config, deps);
    const result = await action.execute({
      sessionId: "agent-session-1",
      channel: "webchat",
      threadId: "sess-1",
      text: "x",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("agentName");
    expect(runAndDeliver).not.toHaveBeenCalled();
  });

  it("errors when the exact AgentSession id is missing", async () => {
    const { deps, runAndDeliver } = makeDeps();
    const action = createResumeSessionAction(config, deps);
    const result = await action.execute({
      channel: "webchat",
      threadId: "sess-1",
      agentName: "main",
      text: "x",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("sessionId");
    }
    expect(runAndDeliver).not.toHaveBeenCalled();
  });
});
