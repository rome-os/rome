// An approval's card, put in the conversation the approval came from. The
// main process sends it on the connections it records sends on, and an action
// worker asks main to, so the card is on record in that chat either way.

import type {
  Channel,
  ChannelsService,
  ChatId,
  PreviewPayload,
  ThreadContext,
} from "@rome-os/app-runtime";
import type { ApprovalCreatedEvent } from "./engine.js";

/** What putting an approval's card in a conversation reads of the approval. */
export type ApprovalCard = Pick<
  ApprovalCreatedEvent,
  "approvalId" | "actionName" | "preview" | "channelContext"
>;

/** What a card is sent with: the connections Rome lists, and a send. */
export type ApprovalCardChannels = Pick<ChannelsService, "list" | "send">;

/**
 * `service` sending on the connection named in `recorded()` when it lists one,
 * so the card goes on record in its chat as the platform shows it. A channel
 * Rome serves itself, such as the dashboard, records its own sends and is
 * sent on through `service`.
 */
export function recordedCardChannels(
  service: ApprovalCardChannels,
  recorded: () => readonly Channel[],
): ApprovalCardChannels {
  return {
    list: () => service.list(),
    send: (target, chatId, message) => {
      const send =
        typeof target === "string"
          ? recorded().find((channel) => channel.name === target)?.send
          : undefined;
      return send ? send.send(chatId, message) : service.send(target, chatId, message);
    },
  };
}

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
  channels: ApprovalCardChannels,
  { approvalId, actionName, preview, channelContext }: ApprovalCard,
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
