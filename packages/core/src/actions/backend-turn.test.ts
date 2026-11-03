import { describe, expect, it, rs } from "@rstest/core";
import type { ChatId, ChatRepository } from "@rome-os/app-runtime";
import type { Channel } from "../channels/channel.js";
import { chatKey, placeIn } from "../chats/place.js";
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
    const send = rs.fn(async (chatId) => ({
      messageId: "wechat-message-1",
      chatId,
    }));
    const wechat: Channel = {
      name: "wechat",
      send: { send, direct: null, activity: null },
      inbound: null,
      accounts: null,
      messages: null,
      directory: null,
    };
    const ensureChannelChat = rs.fn(async () => ({
      id: "channel:wechat:wechat-thread-1",
      agentName: null,
    }));
    const chats = { ensureChannelChat } as unknown as ChatRepository;
    const recordSent = rs.fn(async () => {});
    const place = placeIn(chatKey("wechat", "wechat-thread-1" as ChatId));
    const runner = createBackendTurnRunner({
      agentRunner,
      channel: (name) => (name === "wechat" ? wechat : null),
      chats,
      messages: { recordSent },
      places: {
        placeOfRecord: (id) =>
          id === "channel:wechat:wechat-thread-1" ? { place, channel: "wechat" } : null,
      },
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
    expect(ensureChannelChat).toHaveBeenCalledWith({
      channel: "wechat",
      threadId: "wechat-thread-1",
      agentName: "main",
    });
    expect(recordSent).toHaveBeenCalledWith(
      {
        direction: "fromRome",
        place,
        parts: [{ type: "text", content: "The deferred check is complete." }],
        platformMessageId: "wechat-message-1",
        turnId: "turn-1",
        turnAnswer: true,
      },
      { channel: "wechat" },
    );
  });
  it("delivers a webchat continuation on the send port after showing it on the session stream", async () => {
    const agentRunner = createMockAgentRunner([
      [
        { type: "turn_start", turnId: "turn-1", sessionId: "agent-session-1", userPrompt: "Wake" },
        { type: "result", content: "The deferred check is complete." },
      ],
    ]);
    const order: string[] = [];
    const send = rs.fn(async (chatId: string) => {
      order.push("send");
      return { messageId: "webchat-message-1", chatId };
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

  it("passes a quiet turn's option to the webchat runtime, and nothing for an ordinary one", async () => {
    const run = async (options?: { quiet?: boolean }) => {
      const agentRunner = createMockAgentRunner([
        [
          { type: "turn_start", turnId: "turn-1", sessionId: "s", userPrompt: "Wake" },
          { type: "result", content: "" },
        ],
      ]);
      const webchat = {
        name: "webchat",
        send: {
          send: async () => ({ messageId: "m", chatId: "chat-1" }),
          direct: null,
          activity: null,
        },
      } as unknown as Channel;
      const runner = createBackendTurnRunner({
        agentRunner,
        channel: (name) => (name === "webchat" ? webchat : null),
      });
      const seen: unknown[] = [];
      runner.setWebchatRuntime({
        enqueueSessionTask: async (_sessionId, _task, taskOptions) => {
          seen.push(taskOptions);
        },
      });
      await runner.runAndDeliver(
        { agentName: "main", sessionId: "s", channel: "webchat", threadId: "chat-1", prompt: "p" },
        options,
      );
      return seen;
    };
    expect(await run({ quiet: true })).toEqual([{ quiet: true }]);
    expect(await run()).toEqual([undefined]);
  });

  it("delivers no reply for an agent whose text is private", async () => {
    const agentRunner = createMockAgentRunner([
      [
        { type: "turn_start", turnId: "turn-1", sessionId: "agent-session-1", userPrompt: "Wake" },
        { type: "result", content: "A private note." },
      ],
    ]);
    const send = rs.fn(async (chatId: string) => ({ messageId: "m", chatId }));
    const webchat = {
      name: "webchat",
      send: { send, direct: null, activity: null },
    } as unknown as Channel;
    const runner = createBackendTurnRunner({
      agentRunner,
      channel: (name) => (name === "webchat" ? webchat : null),
      isTextPrivate: (agentName) => agentName === "core:concierge",
    });
    runner.setWebchatRuntime({
      enqueueSessionTask: async (_sessionId, task) => {
        await task({ emit: async () => {} });
      },
    });

    await runner.runAndDeliver({
      agentName: "core:concierge",
      sessionId: "agent-session-1",
      channel: "webchat",
      threadId: "chat-1",
      prompt: "<task_event/>",
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("resumes a webchat continuation with the chat's device folder", async () => {
    const agentRunner = createMockAgentRunner([[{ type: "result", content: "" }]]);
    const folder = { deviceId: "mac", deviceName: "macbook", platform: "macos", path: "/w" };
    const resolveDeviceFolder = rs.fn(async () => folder);
    const runner = createBackendTurnRunner({
      agentRunner,
      channel: () =>
        ({
          name: "webchat",
          send: { send: rs.fn(), direct: null, activity: null },
        }) as unknown as Channel,
      resolveDeviceFolder,
    });
    runner.setWebchatRuntime({
      enqueueSessionTask: async (_sessionId, task) => {
        await task({ emit: async () => {} });
      },
    });

    await runner.runAndDeliver({
      agentName: "main",
      sessionId: "agent-session-1",
      channel: "webchat",
      threadId: "chat-1",
      prompt: "⏰ Time's up: check deployment",
    });

    expect(resolveDeviceFolder).toHaveBeenCalledWith("webchat", "chat-1");
    expect(agentRunner.calls[0].threadContext).toMatchObject({
      channel: "webchat",
      threadId: "chat-1",
      deviceFolder: folder,
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
