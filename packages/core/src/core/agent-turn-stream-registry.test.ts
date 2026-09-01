import { describe, expect, it, rs } from "@rstest/core";
import type { ConversationId } from "@rome-os/app-runtime";
import { createAgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";

const conversation = {
  connectionId: "connection:discord",
  conversationId: "channel-1" as ConversationId,
};

describe("AgentTurnStreamRegistry conversation routing", () => {
  it("resolves the active turn for a provider conversation", () => {
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
    expect(stream.interrupt).toBe(interrupt);

    stream.finish();
    expect(registry.getActiveByConversation(conversation)).toBeUndefined();
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
