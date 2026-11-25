import { describe, expect, it, rs } from "@rstest/core";
import type { ChatRef, ProviderSessionResetPolicy } from "@rome-os/app-runtime";
import { resetPolicyOfMessage, sessionOfMessage } from "./chat-reset-policy.js";

const POLICY: ProviderSessionResetPolicy = { mode: "idle", idleMinutes: 60 };
const MESSAGE = {
  platformMessageId: "message-1",
  threadContext: { channel: "telegram", connectionId: "telegram-1", threadId: "thread-1" },
};

describe("resetPolicyOfMessage", () => {
  it("asks for the policy of the connected account's chat the message arrived in", async () => {
    const policyOf = rs.fn(async (_chat: ChatRef) => POLICY);
    expect(await resetPolicyOfMessage(policyOf, MESSAGE)).toBe(POLICY);
    expect(policyOf).toHaveBeenCalledWith({ connectionId: "telegram-1", chatId: "thread-1" });
  });

  it("asks nothing for a turn that answers no message or has no connected account", async () => {
    const policyOf = rs.fn(async (_chat: ChatRef) => POLICY);
    const { threadContext } = MESSAGE;
    for (const run of [
      { threadContext },
      { ...MESSAGE, threadContext: { channel: "webchat", threadId: "chat-1" } },
    ]) {
      expect(await resetPolicyOfMessage(policyOf, run)).toBeUndefined();
    }
    expect(policyOf).not.toHaveBeenCalled();
  });

  it("hands over no policy when the chat sets none", async () => {
    expect(await resetPolicyOfMessage(async () => null, MESSAGE)).toBeUndefined();
    expect(await resetPolicyOfMessage(undefined, MESSAGE)).toBeUndefined();
  });
});

describe("sessionOfMessage", () => {
  const own = "telegram:thread-1";

  it("opens a message's chat in the session its scope names", async () => {
    const scopeOf = rs.fn(async (_chat: ChatRef) => "account" as const);
    expect(await sessionOfMessage(scopeOf, MESSAGE, own)).toEqual({
      continuityKey: "telegram:*",
      audience: "shared",
    });
    expect(scopeOf).toHaveBeenCalledWith({ connectionId: "telegram-1", chatId: "thread-1" });
    expect(await sessionOfMessage(async () => "chat", MESSAGE, own)).toEqual({
      continuityKey: own,
    });
    expect(await sessionOfMessage(async () => null, MESSAGE, own)).toEqual({ continuityKey: own });
  });

  it("opens any other key as asked, and a turn that answers no message or has no connected account", async () => {
    const scopeOf = rs.fn(async (_chat: ChatRef) => "account" as const);
    const sentinel = `sentinel:${own}:user-1`;
    expect(await sessionOfMessage(scopeOf, MESSAGE, sentinel)).toEqual({ continuityKey: sentinel });
    expect(await sessionOfMessage(scopeOf, { threadContext: MESSAGE.threadContext }, own)).toEqual({
      continuityKey: own,
    });
    const webchat = { ...MESSAGE, threadContext: { channel: "webchat", threadId: "chat-1" } };
    expect(await sessionOfMessage(scopeOf, webchat, "webchat:chat-1")).toEqual({
      continuityKey: "webchat:chat-1",
    });
    expect(await sessionOfMessage(undefined, MESSAGE, own)).toEqual({ continuityKey: own });
    expect(scopeOf).not.toHaveBeenCalled();
  });
});
