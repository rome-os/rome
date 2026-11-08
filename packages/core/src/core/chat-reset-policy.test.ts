import { describe, expect, it, rs } from "@rstest/core";
import type { ChatRef, ProviderSessionResetPolicy } from "@rome-os/app-runtime";
import { resetPolicyOfMessage } from "./chat-reset-policy.js";

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

  it("asks nothing for a run that answers no message, names its session, or has no connected account", async () => {
    const policyOf = rs.fn(async (_chat: ChatRef) => POLICY);
    const { threadContext } = MESSAGE;
    for (const run of [
      { threadContext },
      { ...MESSAGE, sessionId: "session-1" },
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
