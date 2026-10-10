import { describe, expect, it, rs } from "@rstest/core";
import type { ConversationRepository } from "@rome-os/app-runtime";
import type { Channel } from "../channels/channel.js";
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
    const send = rs.fn(async (conversationId) => ({
      messageId: "wechat-message-1",
      conversationId,
    }));
    const wechat: Channel = {
      name: "wechat",
      send: { send, direct: null, activity: null },
      inbound: null,
      accounts: null,
      messages: null,
      directory: null,
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
      channel: (name) => (name === "wechat" ? wechat : null),
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

    expect(send).toHaveBeenCalledWith("wechat-thread-1", {
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
  it("delivers a webchat continuation on the send port after showing it on the session stream", async () => {
    const agentRunner = createMockAgentRunner([
      [
        { type: "turn_start", turnId: "turn-1", sessionId: "agent-session-1", userPrompt: "Wake" },
        { type: "result", content: "The deferred check is complete." },
      ],
    ]);
    const order: string[] = [];
    const send = rs.fn(async (conversationId: string) => {
      order.push("send");
      return { messageId: "webchat-message-1", conversationId };
    });
    const webchat: Channel = {
      name: "webchat",
      send: { send, direct: null, activity: null },
      inbound: null,
      accounts: null,
      messages: null,
      directory: null,
    } as unknown as Channel;
    const emitted: Array<{ type: string; recorded?: boolean }> = [];
    const runner = createBackendTurnRunner({
      agentRunner,
      channel: (name) => (name === "webchat" ? webchat : null),
    });
    runner.setWebchatRuntime({
      enqueueSessionTask: async (_sessionId, task) => {
        await task({
          emit: async (msg, options) => {
            order.push(`emit:${msg.type}`);
            emitted.push({ type: msg.type, recorded: options?.recorded });
          },
        });
      },
    });

    await runner.runAndDeliver({
      agentName: "main",
      sessionId: "agent-session-1",
      channel: "webchat",
      threadId: "chat-1",
      prompt: "⏰ Time's up: check deployment",
    });

    expect(agentRunner.calls[0]).toMatchObject({ persistTrace: true, persistTranscript: false });
    expect(emitted).toEqual([
      { type: "turn_start", recorded: true },
      { type: "result", recorded: true },
    ]);
    expect(order).toEqual(["emit:turn_start", "emit:result", "send"]);
    expect(send).toHaveBeenCalledWith("chat-1", {
      text: "The deferred check is complete.",
      turnId: "turn-1",
    });
  });

  it("refuses to deliver on a channel that cannot send", async () => {
    const agentRunner = createMockAgentRunner([[{ type: "result", content: "Done." }]]);
    const runner = createBackendTurnRunner({
      agentRunner,
      channel: (name) => ({
        name,
        send: null,
        inbound: null,
        accounts: null,
        messages: null,
        directory: null,
      }),
    });

    await expect(
      runner.runAndDeliver({
        agentName: "main",
        sessionId: "agent-session-1",
        channel: "wechat_user",
        threadId: "thread-1",
        prompt: "continue",
      }),
    ).rejects.toThrow('Channel "wechat_user" cannot send');
  });
});
