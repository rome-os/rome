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

  function channels(sendable: boolean) {
    return {
      list: async () => [{ name: "telegram_user", sendable }],
      send: rs.fn<ChannelsService["send"]>(async () => RECEIPT),
    };
  }

  it("puts the card in the conversation the approval came from", async () => {
    const target = channels(true);

    await sendApprovalCard(target, {
      ...approval,
      channelContext: { channel: "telegram_user", threadId: "t1" },
    } as never);

    expect(target.send).toHaveBeenCalledWith("telegram_user", "t1", {
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
    });
  });

  it("sends nothing without a conversation or on a channel that cannot send", async () => {
    const sendable = channels(true);
    const unsendable = channels(false);

    await sendApprovalCard(sendable, approval as never);
    await sendApprovalCard(unsendable, {
      ...approval,
      channelContext: { channel: "telegram_user", threadId: "t1" },
    } as never);

    expect(sendable.send).not.toHaveBeenCalled();
    expect(unsendable.send).not.toHaveBeenCalled();
  });
});
