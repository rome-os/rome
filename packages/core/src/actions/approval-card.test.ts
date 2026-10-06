import { describe, expect, it, rs } from "@rstest/core";
import type { ChannelsService, ConversationId, MessageReceipt } from "@rome-os/app-runtime";
import { sendApprovalCard } from "./approval-card.js";

const RECEIPT: MessageReceipt = { messageId: "m1", conversationId: "c1" as ConversationId };

describe("sendApprovalCard", () => {
  const approval = {
    approvalId: "ap-1",
    actionName: "send_email",
    preview: undefined,
  };

  function channels(connectionIds: string[]) {
    return {
      list: async () => [{ name: "telegram_user", connectionIds }],
      send: rs.fn<ChannelsService["send"]>(async () => RECEIPT),
    };
  }

  it("puts the card in the conversation the approval came from", async () => {
    const target = channels(["tg-a", "tg-b"]);

    await sendApprovalCard(target, {
      ...approval,
      channelContext: { channel: "telegram_user", threadId: "t1", connectionId: "tg-b" },
    } as never);

    expect(target.send).toHaveBeenCalledWith(
      "telegram_user",
      "t1",
      {
        parts: [
          {
            type: "approval_card",
            approvalId: "ap-1",
            actionName: "send_email",
            preview: {
              kind: "generic",
              title: "send_email",
              summary: 'The agent wants to run "send_email" and needs your approval.',
            },
            status: "pending",
          },
        ],
      },
      { connectionId: "tg-b" },
    );
  });

  it("falls back to the channel's only Connection", async () => {
    const target = channels(["tg-a"]);

    await sendApprovalCard(target, {
      ...approval,
      channelContext: { channel: "telegram_user", threadId: "t1" },
    } as never);

    expect(target.send.mock.calls[0]?.[3]).toEqual({ connectionId: "tg-a" });
  });

  it("sends nothing without a conversation or a Connection it can tell", async () => {
    const target = channels(["tg-a", "tg-b"]);

    await sendApprovalCard(target, approval as never);
    await sendApprovalCard(target, {
      ...approval,
      channelContext: { channel: "telegram_user", threadId: "t1" },
    } as never);

    expect(target.send).not.toHaveBeenCalled();
  });
});
