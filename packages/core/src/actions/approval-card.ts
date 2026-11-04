// An approval's card, put in the conversation the approval came from. The
// main process and an action worker both send it through the channels
// service, so each answers `onApprovalCreated` the same way.

import type { ChannelsService, ChatId, PreviewPayload, ThreadContext } from "@rome-os/app-runtime";
import type { ApprovalCreatedEvent } from "./engine.js";

/** What a card says where someone other than the guardian may read it. The
 *  preview holds what the approval holds back, such as a message meant for
 *  another chat, so it stays off the card there. */
const WITHHELD_PREVIEW: PreviewPayload = {
  kind: "generic",
  title: "an action",
  summary: "The agent is waiting for the guardian's approval before it acts.",
};

/** Whether only the guardian reads the chat: the dashboard, or a private chat
 *  whose sender Rome knows to be the guardian. An email thread is never one,
 *  because Rome marks every email thread private while its other recipients
 *  read each reply too. */
function readByGuardianOnly(context: ThreadContext, platform: string | undefined): boolean {
  if (context.channel === "webchat") return true;
  if (platform === "email") return false;
  return context.threadType === "private" && context.senderBondLevel === "guardian";
}

/**
 * Put an approval's card in the conversation the approval came from. Nothing
 * is sent for an approval with no conversation or on a channel that cannot
 * send. The card shows its preview only where the guardian alone reads it. A
 * platform that cannot draw the card sends its plain-text version. A send
 * that fails rejects here, so the engine logs it.
 */
export async function sendApprovalCard(
  channels: Pick<ChannelsService, "list" | "send">,
  { approvalId, actionName, preview, channelContext }: ApprovalCreatedEvent,
): Promise<void> {
  if (!channelContext) return;
  const target = (await channels.list()).find((channel) => channel.name === channelContext.channel);
  if (!target?.sendable) return;
  const payload = !readByGuardianOnly(channelContext, target.platform)
    ? WITHHELD_PREVIEW
    : (preview ?? {
        kind: "generic" as const,
        title: actionName,
        summary: `The agent wants to run "${actionName}" and needs your approval.`,
      });
  await channels.send(channelContext.channel, channelContext.threadId as ChatId, {
    parts: [
      {
        type: "approval_card",
        approvalId,
        actionName,
        preview: payload,
        status: "pending",
      },
    ],
  });
}
