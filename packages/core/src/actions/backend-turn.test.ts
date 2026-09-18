import { describe, expect, it, rs } from "@rstest/core";
import type { ConversationId, ConversationRepository, TalkRouter } from "@rome-os/app-runtime";
import type { AgentMessage } from "../types.js";
import { RunDelivery } from "../connections/delivery/run-delivery.js";
import { DeliveryScheduler } from "../connections/delivery/scheduler.js";
import { plainTextCodec } from "../connections/delivery/transport.js";
import { telegramDeliveryProfile } from "../connections/integrations/delivery-profiles.js";
import { createMockAgentRunner } from "../test/helpers.js";
import { createBackendTurnRunner } from "./backend-turn.js";

describe("backend turn delivery", () => {
  it.each([
    false,
    true,
  ])("observes an approval continuation and closes its owner on failure=%s", async (fail) => {
    const visible: string[] = [];
    let owner: RunDelivery | undefined;
    const router = {
      list: async () => [],
      send: rs.fn(),
      subscribe: () => () => {},
      feature: () => null,
    } as TalkRouter;
    const runner = createBackendTurnRunner({
      agentRunner: createMockAgentRunner([]),
      talkRouter: router,
      async createRunDelivery(_params, turnId) {
        owner = new RunDelivery(
          turnId,
          { conversationId: "dm" as ConversationId },
          {
            profile: {
              ...telegramDeliveryProfile("synthetic"),
              operationSpacingMs: 0,
              createSpacingMs: 0,
              updateSpacingMs: 0,
              conversationSpacingMs: 0,
            },
            codec: plainTextCodec,
            assertAuthorized() {},
            async create(target, text) {
              visible.push(text);
              return { ...target, messageId: "one" };
            },
            async update(_receipt, text) {
              visible[0] = text;
            },
          },
          new DeliveryScheduler(),
          { async record() {} },
          () => {},
        );
        return owner;
      },
    });
    async function* messages(): AsyncIterable<AgentMessage> {
      yield {
        type: "turn_start",
        turnId: "approval-run",
        sessionId: "session",
        userPrompt: "approved",
      };
      yield { type: "text_delta", content: "part" };
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(visible).toEqual(["part"]);
      if (fail) throw new Error("provider failed");
      yield { type: "text", content: "answer", turnPhase: "final" };
      yield { type: "result", content: "answer" };
    }
    const observed = runner.observeContinuation!(
      {
        agentName: "main",
        sessionId: "session",
        channel: "synthetic",
        threadId: "dm",
        prompt: "approved",
      },
      messages(),
    );
    if (fail) await expect(observed).rejects.toThrow("provider failed");
    else await observed;
    expect(visible).toEqual([fail ? "part" : "answer"]);
    expect(owner?.terminal).toBe(true);
    expect(router.send).not.toHaveBeenCalled();
  });
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
