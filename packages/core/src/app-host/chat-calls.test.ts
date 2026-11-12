import { describe, it, expect, rs } from "@rstest/core";
import { chatWorkerCalls, type ChatWorkerCallsDeps } from "./chat-calls.js";

function makeCalls(overrides: Partial<ChatWorkerCallsDeps> = {}) {
  return chatWorkerCalls({
    channelsService: { list: rs.fn(), send: rs.fn(), query: rs.fn() } as never,
    chatSettings: { list: rs.fn(), get: rs.fn(), update: rs.fn(), reset: rs.fn() } as never,
    agentNames: { resolve: rs.fn() } as never,
    ...overrides,
  });
}

describe("chatSettings.get", () => {
  it("reads the settings of the chat the ref names", async () => {
    const get = rs.fn(async () => ({ agentName: "main" }));
    const calls = makeCalls({
      chatSettings: { list: rs.fn(), get, update: rs.fn(), reset: rs.fn() } as never,
    });
    const ref = { connectionId: "conn-1", chatId: "c1" };

    expect(await calls["chatSettings.get"]({ ref })).toEqual({ agentName: "main" });
    expect(get).toHaveBeenCalledWith(ref);
  });

  it("rejects a ref with no connection", async () => {
    const calls = makeCalls();

    await expect(calls["chatSettings.get"]({ ref: { chatId: "c1" } })).rejects.toThrow(
      "chatSettings.get: invalid params",
    );
  });
});

describe("channels.send", () => {
  it("sends as the person of the calling action's dashboard chat", async () => {
    const send = rs.fn(async () => ({ messageId: "m1" }));
    const calls = makeCalls({
      channelsService: { list: rs.fn(), send, query: rs.fn() } as never,
    });

    await calls["channels.send"](
      { channel: "webchat", chatId: "c1", message: { text: "hi" } },
      {
        callerActionContext: {
          actor: { kind: "guardian", userId: "guardian", via: "cookie" },
          channelContext: { channel: "webchat", threadId: "t1" },
        },
      },
    );

    expect(send).toHaveBeenCalledWith("webchat", "c1", { text: "hi" });
  });
});
