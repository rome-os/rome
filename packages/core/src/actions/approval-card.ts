// An approval's card, put in the conversation the approval came from. The
// main process and an action worker both send it through the channels
// service, so each answers `onApprovalCreated` the same way.

import type { ChannelsService, ConversationId } from "@rome-os/app-runtime";
import type { ApprovalCreatedEvent } from "./engine.js";

/**
 * Put an approval's card in the conversation the approval came from. Nothing
 * is sent for an approval with no conversation, or on a channel that cannot
 * send.
 */
export async function sendApprovalCard(
  channels: Pick<ChannelsService, "list" | "send">,
  { approvalId, actionName, preview, channelContext }: ApprovalCreatedEvent,
): Promise<void> {
  if (!channelContext) return;
  const target = (await channels.list()).find((channel) => channel.name === channelContext.channel);
  if (!target?.sendable) return;
  const payload = preview ?? {
    kind: "generic" as const,
    title: actionName,
    summary: `The agent wants to run "${actionName}" and needs your approval.`,
  };
  await channels.send(channelContext.channel, channelContext.threadId as ConversationId, {
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
