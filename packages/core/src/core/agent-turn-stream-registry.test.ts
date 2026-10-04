import { describe, expect, it, rs } from "@rstest/core";
import type { ConversationId } from "@rome-os/app-runtime";
import {
  appendBufferedToolOutput,
  createAgentTurnStreamRegistry,
  MAX_BUFFERED_TOOL_OUTPUT_CHARS,
} from "./agent-turn-stream-registry.js";

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

describe("AgentTurnStreamRegistry output replay", () => {
  it("coalesces and caps retained command output without dropping live chunks", () => {
    const registry = createAgentTurnStreamRegistry();
    const stream = registry.register({ sessionId: "session", turnId: "turn", agentName: "main" });
    const received: string[] = [];
    stream.subscribe((event) => {
      if (event.type === "tool_output_delta") received.push(event.content);
    });

    stream.publish({ type: "tool_output_delta", toolUseId: "command", content: "first" });
    stream.publish({
      type: "tool_output_delta",
      toolUseId: "command",
      content: "x".repeat(MAX_BUFFERED_TOOL_OUTPUT_CHARS),
    });

    expect(received).toEqual(["first", "x".repeat(MAX_BUFFERED_TOOL_OUTPUT_CHARS)]);
    expect(stream.messages()).toHaveLength(1);
    const replay = stream.messages()[0];
    expect(replay).toMatchObject({ type: "tool_output_delta", toolUseId: "command" });
    expect((replay as Extract<typeof replay, { type: "tool_output_delta" }>).content.length).toBe(
      MAX_BUFFERED_TOOL_OUTPUT_CHARS,
    );
  });

  it("keeps an already capped replay stable", () => {
    const capped = appendBufferedToolOutput("x".repeat(MAX_BUFFERED_TOOL_OUTPUT_CHARS), "later");
    expect(capped).toHaveLength(MAX_BUFFERED_TOOL_OUTPUT_CHARS);
  });
});
