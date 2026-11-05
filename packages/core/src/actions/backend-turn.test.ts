import { describe, expect, it, rs } from "@rstest/core";
import type { ChatRepository } from "@rome-os/app-runtime";
import type { Channel } from "../chats/connected-accounts/connected-account.js";
import { createMockAgentRunner } from "../test/helpers.js";
import type { SpeakerReplies } from "../sessions/speaker-replies.js";
import { createBackendTurnRunner } from "./backend-turn.js";

describe("backend turn delivery", () => {
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

  it.each([
    ["completed", "completed"],
    ["error", "failed"],
    ["interrupted", "failed"],
  ] as const)("reports a turn that ended %s as %s", async (status, outcome) => {
    const agentRunner = createMockAgentRunner([
      [
        { type: "turn_start", turnId: "turn-1", sessionId: "s", userPrompt: "Wake" },
        { type: "result", content: "" },
        { type: "turn_end", turnId: "turn-1", status, durationMs: 5 },
      ],
    ]);
    const webchat = {
      name: "webchat",
      send: { send: rs.fn(), direct: null, activity: null },
    } as unknown as Channel;
    const runner = createBackendTurnRunner({
      agentRunner,
      channel: (name) => (name === "webchat" ? webchat : null),
    });
    runner.setWebchatRuntime({
      enqueueSessionTask: async (_sessionId, task) => {
        await task({ emit: async () => undefined });
      },
    });
    const params = {
      agentName: "core:concierge",
      sessionId: "s",
      channel: "webchat",
      threadId: "concierge",
      prompt: "<external_events/>",
    };
    expect(await runner.runAndReport(params)).toBe(outcome);
  });

  it("reports a turn that never ran as failed", async () => {
    const agentRunner = createMockAgentRunner([[]]);
    const webchat = {
      name: "webchat",
      send: { send: rs.fn(), direct: null, activity: null },
    } as unknown as Channel;
    const runner = createBackendTurnRunner({
      agentRunner,
      channel: (name) => (name === "webchat" ? webchat : null),
    });
    // The session queue drops the task without running it.
    runner.setWebchatRuntime({ enqueueSessionTask: async () => undefined });
    expect(
      await runner.runAndReport({
        agentName: "core:concierge",
        sessionId: "s",
        channel: "webchat",
        threadId: "concierge",
        prompt: "x",
      }),
    ).toBe("failed");
  });

  it("asks the runner to keep a turn's input only when the caller labels it", async () => {
    const run = async (options?: { inputLabel?: string }) => {
      const agentRunner = createMockAgentRunner([
        [
          { type: "turn_start", turnId: "turn-1", sessionId: "s", userPrompt: "Wake" },
          { type: "result", content: "" },
        ],
      ]);
      const webchat = {
        name: "webchat",
        send: { send: rs.fn(), direct: null, activity: null },
      } as unknown as Channel;
      const runner = createBackendTurnRunner({
        agentRunner,
        channel: (name) => (name === "webchat" ? webchat : null),
      });
      runner.setWebchatRuntime({
        enqueueSessionTask: async (_sessionId, task) => {
          await task({ emit: async () => undefined });
        },
      });
      await runner.runAndDeliver(
        {
          agentName: "core:concierge",
          sessionId: "s",
          channel: "webchat",
          threadId: "concierge",
          prompt: "<external_events/>",
        },
        options,
      );
      return agentRunner.calls[0];
    };
    expect(await run({ inputLabel: "Following · digest (2)" })).toMatchObject({
      inputLabel: "Following · digest (2)",
    });
    // A task event, a nudge or a defer resume passes no label and keeps no input.
    expect(await run()).not.toHaveProperty("inputLabel");
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

  it("runs every turn where resolveTurn sends it, before it queues", async () => {
    const queued: string[] = [];
    const agentRunner = createMockAgentRunner([[{ type: "result", content: "" }]]);
    const webchat = {
      name: "webchat",
      send: {
        send: async () => ({ messageId: "m", chatId: "concierge" }),
        direct: null,
        activity: null,
      },
    } as unknown as Channel;
    const runner = createBackendTurnRunner({
      agentRunner,
      channel: (name) => (name === "webchat" ? webchat : null),
      resolveTurn: async (params) => ({
        ...params,
        threadId: "concierge",
        sessionId: "main-runtime",
      }),
    });
    runner.setWebchatRuntime({
      enqueueSessionTask: async (sessionId, task) => {
        queued.push(sessionId);
        await task({ emit: async () => {} });
      },
    });
    await runner.runAndDeliver({
      agentName: "core:concierge",
      sessionId: "topic-runtime",
      channel: "webchat",
      threadId: "archived-topic",
      prompt: "Wake",
    });
    expect(queued).toEqual(["concierge"]);
    expect(agentRunner.calls[0]).toMatchObject({
      sessionId: "main-runtime",
      threadContext: { threadId: "concierge" },
    });
  });

  it("runs beforeTurn when a queued webchat continuation starts, not when it is queued", async () => {
    const order: string[] = [];
    const webchat = {
      name: "webchat",
      send: {
        send: async () => ({ messageId: "m", chatId: "concierge" }),
        direct: null,
        activity: null,
      },
    } as unknown as Channel;
    const turns = createMockAgentRunner([[{ type: "result", content: "" }]]);
    const run = turns.run.bind(turns);
    turns.run = (params) => {
      order.push("turn");
      return run(params);
    };
    const runner = createBackendTurnRunner({
      agentRunner: turns,
      channel: (name) => (name === "webchat" ? webchat : null),
      beforeTurn: async ({ threadId }) => {
        order.push(`before:${threadId}`);
      },
    });
    runner.setWebchatRuntime({
      enqueueSessionTask: async (_sessionId, task) => {
        order.push("queued");
        await task({ emit: async () => {} });
      },
    });
    await runner.runAndDeliver({
      agentName: "core:concierge",
      sessionId: "s",
      channel: "webchat",
      threadId: "concierge",
      prompt: "Wake",
    });
    expect(order).toEqual(["queued", "before:concierge", "turn"]);
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
      chats: { ensureChannelChat: async () => ({ id: "session-1" }) },
      replies: { send: async () => null },
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

  describe("through the session's speaker", () => {
    const answered = () =>
      createMockAgentRunner([
        [
          { type: "turn_start", turnId: "turn-1", sessionId: "agent-session-1", userPrompt: "p" },
          { type: "result", content: "Done." },
        ],
      ]);
    type Send = NonNullable<Channel["send"]>["send"];
    const wechatWith = (send: Send): Channel => ({
      name: "wechat",
      send: { send, direct: null, activity: null },
      inbound: null,
      accounts: null,
      messages: null,
      directory: null,
    });
    const chats = {
      ensureChannelChat: async () => ({ id: "session-1", agentName: null }),
    } as unknown as ChatRepository;
    const params = {
      agentName: "main",
      sessionId: "agent-session-1",
      channel: "wechat",
      threadId: "wechat-thread-1",
      prompt: "p",
    };

    it("says the reply through the speaker, as the turn's answer", async () => {
      const send = rs.fn<Send>(async (chatId) => ({ chatId }));
      const wechat = wechatWith(send);
      const replies = {
        send: rs.fn<SpeakerReplies["send"]>(async () => ({
          id: 1,
          at: new Date(),
          sent: "k",
          speaker: {} as never,
          landedIn: null,
        })),
      };
      const runner = createBackendTurnRunner({
        agentRunner: answered(),
        channel: (name) => (name === "wechat" ? wechat : null),
        chats,
        replies,
      });

      await runner.runAndDeliver(params);

      expect(replies.send).toHaveBeenCalledWith(
        "session-1",
        wechat,
        { text: "Done." },
        { turnId: "turn-1", agent: "main" },
      );
      // The speaker's adapter sends it, not the runner.
      expect(send).not.toHaveBeenCalled();
    });

    it("runs no turn whose reply no speaker can say, and sends nothing", async () => {
      const send = rs.fn<Send>(async (chatId) => ({ chatId }));
      const agentRunner = answered();
      const runner = createBackendTurnRunner({
        agentRunner,
        channel: () => wechatWith(send),
      });

      await expect(runner.runAndDeliver(params)).rejects.toThrow(
        'No speaker can say a reply on "wechat", so it was not sent',
      );
      expect(agentRunner.calls).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();
    });

    it("keeps the turn's trace but leaves its answer for the speaker to record", async () => {
      const agentRunner = answered();
      const runner = createBackendTurnRunner({
        agentRunner,
        channel: () => wechatWith(rs.fn<Send>(async (chatId) => ({ chatId }))),
        chats,
        replies: { send: async () => null },
      });

      await runner.runAndDeliver(params).catch(() => {});

      expect(agentRunner.calls[0]).toMatchObject({ persistAnswer: false });
      expect(agentRunner.calls[0]).not.toHaveProperty("persistTrace", false);
      expect(agentRunner.calls[0]).not.toHaveProperty("persistTranscript", false);
    });

    it("sends nothing, and says which session, when the session stands in no chat", async () => {
      const send = rs.fn<Send>(async (chatId) => ({ chatId }));
      const runner = createBackendTurnRunner({
        agentRunner: answered(),
        channel: () => wechatWith(send),
        chats,
        replies: { send: async () => null },
      });

      await expect(runner.runAndDeliver(params)).rejects.toThrow(
        "Session session-1 stands in no chat",
      );
      expect(send).not.toHaveBeenCalled();
    });
  });
});
