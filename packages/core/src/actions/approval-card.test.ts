import { describe, expect, it, rs } from "@rstest/core";
import {
  type ChannelsService,
  type ChatId,
  ChannelSendRefused,
  type MessageReceipt,
} from "@rome-os/app-runtime";
import { sendApprovalCard } from "./approval-card.js";

const RECEIPT: MessageReceipt = { messageId: "m1", chatId: "c1" as ChatId };

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
      channelContext: {
        channel: "telegram_user",
        threadId: "t1",
        threadType: "private",
        senderBondLevel: "guardian",
      },
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

  it("keeps the preview off a card someone other than the guardian may read", async () => {
    const preview = {
      kind: "sensitive_message",
      channel: "telegram",
      threadId: "elsewhere",
      text: "My private notes",
    };
    for (const channelContext of [
      {
        channel: "telegram_user",
        threadId: "t1",
        threadType: "group",
        senderBondLevel: "guardian",
      },
      {
        channel: "telegram_user",
        threadId: "t1",
        threadType: "private",
        senderBondLevel: "acquaintance",
      },
      { channel: "telegram_user", threadId: "t1" },
    ]) {
      const target = channels(true);

      await sendApprovalCard(target, { ...approval, preview, channelContext } as never);

      const [, , message] = target.send.mock.calls[0] ?? [];
      expect(JSON.stringify(message)).not.toContain("My private notes");
      expect(message?.parts?.[0]).toMatchObject({
        type: "approval_card",
        preview: { kind: "generic", title: "an action" },
      });
    }
  });

  it("keeps the preview off a card in an email thread, which every recipient reads", async () => {
    const target = {
      list: async () => [{ name: "gmail", platform: "email", sendable: true }],
      send: rs.fn<ChannelsService["send"]>(async () => RECEIPT),
    };

    await sendApprovalCard(target, {
      ...approval,
      preview: { kind: "generic", title: "Secret plan", summary: "My private notes" },
      channelContext: {
        channel: "gmail",
        threadId: "t1",
        threadType: "private",
        senderBondLevel: "guardian",
      },
    } as never);

    const [, , message] = target.send.mock.calls[0] ?? [];
    expect(JSON.stringify(message)).not.toContain("My private notes");
    expect(message?.parts?.[0]).toMatchObject({ preview: { title: "an action" } });
  });

  it("rejects with the refusal of a channel that cannot show a card", async () => {
    const target = channels(true);
    target.send.mockRejectedValue(
      new ChannelSendRefused("part_unsupported", "telegram_user shows text only"),
    );

    await expect(
      sendApprovalCard(target, {
        ...approval,
        channelContext: { channel: "telegram_user", threadId: "t1" },
      } as never),
    ).rejects.toMatchObject({ name: "ChannelSendRefused", reason: "part_unsupported" });
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
