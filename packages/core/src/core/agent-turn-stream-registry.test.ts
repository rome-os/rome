import { describe, expect, it, rs } from "@rstest/core";
import type { ConversationId } from "@rome-os/app-runtime";
import { createAgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";

const conversation = {
  connectionId: "connection:discord",
  conversationId: "channel-1" as ConversationId,
};

describe("AgentTurnStreamRegistry conversation routing", () => {
  it("resolves the active turn for a provider conversation", async () => {
    const registry = createAgentTurnStreamRegistry();
    const interrupt = rs.fn(async () => undefined);
    const stream = registry.register({
      sessionId: "session-1",
      turnId: "turn-1",
      agentName: "main",
      conversation,
      initiatorId: "user-1",
      interrupt,
    });

    expect(registry.getActiveByConversation(conversation)).toBe(stream);
    expect(stream.initiatorId).toBe("user-1");
    await stream.interrupt?.("stop");
    expect(interrupt).toHaveBeenCalledWith("stop");

    stream.finish();
    expect(registry.getActiveByConversation(conversation)).toBeUndefined();
  });

  it("closes output before interrupting and also stops an owner attached during interruption", async () => {
    const registry = createAgentTurnStreamRegistry();
    const calls: string[] = [];
    const stream = registry.register({
      sessionId: "session",
      turnId: "run",
      agentName: "main",
      async interrupt() {
        calls.push("provider");
      },
    });
    stream.onInterrupt?.(() => {
      calls.push("output");
    });
    await stream.interrupt?.();
    stream.onInterrupt?.(() => {
      calls.push("late-output");
    });
    expect(calls).toEqual(["output", "provider", "late-output"]);
    stream.finish();
  });

  it("does not let an older turn clear a newer conversation route", () => {
    const registry = createAgentTurnStreamRegistry();
    const older = registry.register({
      sessionId: "session-1",
      turnId: "turn-1",
      agentName: "main",
      conversation,
    });
    const newer = registry.register({
      sessionId: "session-2",
      turnId: "turn-2",
      agentName: "main",
      conversation,
    });

    older.finish();
    expect(registry.getActiveByConversation(conversation)).toBe(newer);
  });
});
