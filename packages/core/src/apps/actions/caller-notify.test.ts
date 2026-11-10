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
  it("rings the owner of the calling chat: a visitor by account, the guardian with none", async () => {
    const { notify, sent } = recorder();
    await sendForCaller(
      notify,
      ownerOfChat,
      { actor: visitor, chatId: "visitor-chat" },
      {
        body: "remind me",
      },
    );
    await sendForCaller(
      notify,
      ownerOfChat,
      { actor: guardian, chatId: "guardian-chat" },
      {
        body: "build done",
      },
    );
    await sendForCaller(notify, ownerOfChat, { chatId: null }, undefined);
    expect(sent).toEqual([
      { body: "remind me", recipient: "acct-v" },
      { body: "build done" },
      undefined,
    ]);
  });

  it("never rings the guardian for a visitor's call, even with no chat to name", async () => {
    const { notify, sent } = recorder();
    await sendForCaller(notify, ownerOfChat, { actor: visitor, chatId: null }, { body: "x" });
    await sendForCaller(notify, ownerOfChat, { actor: visitor, chatId: "gone" }, undefined);
    expect(sent).toEqual([{ body: "x", recipient: "acct-v" }, { recipient: "acct-v" }]);
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

  it("reads the caller from the running action in the main process", async () => {
    const { notify, sent } = recorder();
    const service = callerNotifyService(notify, ownerOfChat);
    await actionExecutionContext.run(
      {
        executionId: "e1",
        rootExecutionId: "e1",
        initiator: "agent",
        actor: visitor,
        channelContext: { channel: "webchat", threadId: "visitor-chat" },
      },
      () => service.send({ body: "hi" }),
    );
    expect(sent).toEqual([{ body: "hi", recipient: "acct-v" }]);
  });
});
