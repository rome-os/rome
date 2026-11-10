import { describe, expect, it, rs } from "@rstest/core";
import type { SystemNotifyContent } from "../../lib/notify-client.js";
import { actionCaller, callerNotifyService, sendForCaller } from "./caller-notify.js";
import { actionExecutionContext } from "./context.js";

const owners: Record<string, string> = {
  "guardian-chat": "guardian",
  "visitor-chat": "visitor:acct-v",
};
const ownerOfChat = async (chatId: string) => owners[chatId] ?? null;
const visitor = { kind: "visitor" as const, accountId: "acct-v", email: "v@example.com" };
const other = { kind: "visitor" as const, accountId: "acct-w", email: "w@example.com" };
const guardian = { kind: "guardian" as const, userId: "seat", via: "cookie" as const };

function recorder() {
  const sent: Array<SystemNotifyContent | undefined> = [];
  const notify = {
    send: rs.fn(async (content?: SystemNotifyContent) => {
      sent.push(content);
      return { kind: "ok" as const, attempted: 1, sent: 1, failed: 0 };
    }),
  };
  return { notify, sent };
}

describe("send_notification's recipient", () => {
  it("rings the person who acted, whoever owns the chat", async () => {
    const { notify, sent } = recorder();
    // A visitor in the guardian's chat, and in another visitor's chat.
    await sendForCaller(
      notify,
      ownerOfChat,
      { actor: visitor, chatId: "guardian-chat" },
      {
        body: "a",
      },
    );
    await sendForCaller(
      notify,
      ownerOfChat,
      { actor: other, chatId: "visitor-chat" },
      {
        body: "b",
      },
    );
    // The guardian in a visitor's chat.
    await sendForCaller(
      notify,
      ownerOfChat,
      { actor: guardian, chatId: "visitor-chat" },
      {
        body: "c",
      },
    );
    expect(sent).toEqual([
      { body: "a", recipient: "acct-v" },
      { body: "b", recipient: "acct-w" },
      { body: "c" },
    ]);
  });

  it("never names the guardian for a visitor's call, with or without a chat", async () => {
    const { notify, sent } = recorder();
    await sendForCaller(notify, ownerOfChat, { actor: visitor, chatId: null }, { body: "x" });
    await sendForCaller(notify, ownerOfChat, { actor: visitor, chatId: "gone" }, undefined);
    expect(sent).toEqual([{ body: "x", recipient: "acct-v" }, { recipient: "acct-v" }]);
  });

  it("sends a call no person made to the calling chat's owner, then the guardian", async () => {
    const { notify, sent } = recorder();
    await sendForCaller(notify, ownerOfChat, { chatId: "visitor-chat" }, { body: "routine" });
    await sendForCaller(notify, ownerOfChat, { chatId: "guardian-chat" }, { body: "routine" });
    await sendForCaller(notify, ownerOfChat, { chatId: "gone" }, undefined);
    await sendForCaller(notify, ownerOfChat, { chatId: null }, undefined);
    expect(sent).toEqual([
      { body: "routine", recipient: "acct-v" },
      { body: "routine" },
      undefined,
      undefined,
    ]);
  });

  it("reads only a dashboard chat as the calling chat", () => {
    expect(
      actionCaller({ actor: visitor, channelContext: { channel: "webchat", threadId: "c1" } }),
    ).toEqual({ actor: visitor, chatId: "c1" });
    expect(actionCaller({ channelContext: { channel: "telegram", threadId: "t1" } })).toEqual({
      actor: undefined,
      chatId: null,
    });
  });

  it("reads the acting visitor from the running action in the main process, in a shared chat", async () => {
    const { notify, sent } = recorder();
    const service = callerNotifyService(notify, ownerOfChat);
    await actionExecutionContext.run(
      {
        executionId: "e1",
        rootExecutionId: "e1",
        initiator: "agent",
        actor: visitor,
        channelContext: { channel: "webchat", threadId: "guardian-chat" },
      },
      () => service.send({ body: "hi" }),
    );
    expect(sent).toEqual([{ body: "hi", recipient: "acct-v" }]);
  });
});
