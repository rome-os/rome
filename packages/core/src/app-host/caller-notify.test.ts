import { describe, expect, it, rs } from "@rstest/core";
import type { SystemNotifyContent } from "../instance/notify-client.js";
import { actionCaller, callerNotifyService, sendForCaller } from "./caller-notify.js";
import { actionExecutionContext } from "../apps/actions/context.js";

// Only a Concierge chat is private to one person; every other chat is shared.
const privateOwners: Record<string, string> = {
  "guardian-concierge": "guardian",
  "visitor-concierge": "visitor:acct-v",
};
const ownerOfChat = async (chatId: string) => privateOwners[chatId] ?? null;
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
  it("rings the owner of a private chat", async () => {
    const { notify, sent } = recorder();
    await sendForCaller(notify, ownerOfChat, { chatId: "visitor-concierge" }, { body: "a" });
    await sendForCaller(
      notify,
      ownerOfChat,
      { actor: guardian, chatId: "guardian-concierge" },
      {
        body: "b",
      },
    );
    expect(sent).toEqual([{ body: "a", recipient: "acct-v" }, { body: "b" }]);
  });

  it("rings the one person the turn acts for in a shared chat, whoever owns it", async () => {
    const { notify, sent } = recorder();
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

  it("refuses a shared chat's call with no one person, never falling back to its owner", async () => {
    const { notify, sent } = recorder();
    // No one acted, or more than one person's input is in the turn: both
    // reach the action with no actor.
    expect(
      await sendForCaller(notify, ownerOfChat, { chatId: "visitor-chat" }, { body: "x" }),
    ).toEqual({ kind: "recipient_unknown" });
    expect(await sendForCaller(notify, ownerOfChat, { chatId: "gone" }, undefined)).toEqual({
      kind: "recipient_unknown",
    });
    expect(sent).toEqual([]);
  });

  it("rings the guardian for a call with no chat, unless a visitor made it", async () => {
    const { notify, sent } = recorder();
    await sendForCaller(notify, ownerOfChat, { chatId: null }, undefined);
    await sendForCaller(notify, ownerOfChat, { actor: visitor, chatId: null }, { body: "x" });
    expect(sent).toEqual([undefined, { body: "x", recipient: "acct-v" }]);
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
