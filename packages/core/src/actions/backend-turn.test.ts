import { describe, expect, it, rs } from "@rstest/core";
import type { ConversationRepository, TalkRouter } from "@rome-os/app-runtime";
import { createMockAgentRunner } from "../test/helpers.js";
import { createBackendTurnRunner } from "./backend-turn.js";

describe("backend turn delivery", () => {
  it("records the provider delivery id for a messaging-channel continuation", async () => {
    const agentRunner = createMockAgentRunner([
      [
        {
          type: "turn_start",
          turnId: "turn-1",
          sessionId: "agent-session-1",
          userPrompt: "Time's up",
        },
        { type: "result", content: "The deferred check is complete." },
      ],
    ]);
    const send = rs.fn(async (_connectionId, conversationId) => ({
      messageId: "wechat-message-1",
      conversationId,
    }));
    const talkRouter: TalkRouter = {
      list: async () => [{ connectionId: "wechat-test", service: "wechat" }],
      send,
      subscribe: () => () => {},
      feature: () => null,
    };
    const ensureChannelConversation = rs.fn(async () => ({
      id: "channel:wechat:wechat-thread-1",
      agentName: null,
    }));
    const recordOutboundMessage = rs.fn(async () => {});
    const conversations = {
      ensureChannelConversation,
      recordOutboundMessage,
    } as unknown as ConversationRepository;
    const runner = createBackendTurnRunner({
      agentRunner,
      talkRouter,
      conversations,
    });

    await runner.runAndDeliver({
      agentName: "main",
      sessionId: "agent-session-1",
      channel: "wechat",
      threadId: "wechat-thread-1",
      channelUserId: "wechat-user-1",
      prompt: "⏰ Time's up: check deployment",
    });

    expect(send).toHaveBeenCalledWith("wechat-test", "wechat-thread-1", {
      text: "The deferred check is complete.",
      turnId: "turn-1",
    });
    expect(ensureChannelConversation).toHaveBeenCalledWith({
      channel: "wechat",
      threadId: "wechat-thread-1",
      agentName: "main",
    });
    expect(recordOutboundMessage).toHaveBeenCalledWith({
      sessionId: "channel:wechat:wechat-thread-1",
      content: JSON.stringify([{ type: "text", content: "The deferred check is complete." }]),
      platformMessageId: "wechat-message-1",
      senderId: "rome",
      senderName: "Rome",
      turnId: "turn-1",
      knownToProvider: true,
    });
  });
});
