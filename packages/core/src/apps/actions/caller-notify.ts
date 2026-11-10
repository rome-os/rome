// Whose phone `send_notification` rings: the owner of the chat that calls it,
// with no chat the guardian. A visitor's call never reaches the guardian:
// docs/architecture/notification-delivery.md.
import type { SessionActor } from "../../access/session-actor.js";
import { WEBCHAT_CHANNEL } from "../../chats/dashboard/dashboard-account.js";
import { GUARDIAN_OWNER, recipientOf, type ConciergeOwner } from "../../concierge/owner.js";
import type {
  NotifyContent,
  NotifyService,
  SendOutcome,
  SystemNotifyContent,
} from "../../lib/notify-client.js";
import { actionExecutionContext, type ActionExecutionStore } from "./context.js";

/** The person and the dashboard chat behind an action's call. */
export interface ActionCaller {
  actor?: SessionActor;
  chatId: string | null;
}

export function actionCaller(
  context: Pick<ActionExecutionStore, "actor" | "channelContext"> | undefined,
): ActionCaller {
  const thread = context?.channelContext;
  return {
    actor: context?.actor,
    chatId: thread?.channel === WEBCHAT_CHANNEL && thread.threadId ? thread.threadId : null,
  };
}

/**
 * The Rome Cloud account a call's push goes to: the calling chat's owner's,
 * or, with no chat the caller can name, the calling visitor's. Undefined
 * means the guardian.
 */
export async function notifyRecipient(
  caller: ActionCaller,
  ownerOfChat: (chatId: string) => Promise<ConciergeOwner | null>,
): Promise<string | undefined> {
  const owner = caller.chatId ? await ownerOfChat(caller.chatId) : null;
  if (owner) return recipientOf(owner);
  return caller.actor?.kind === "visitor" ? caller.actor.accountId : recipientOf(GUARDIAN_OWNER);
}

/** Sends `content` to the person `caller` stands for. */
export async function sendForCaller(
  notify: { send(content?: SystemNotifyContent): Promise<SendOutcome> },
  ownerOfChat: (chatId: string) => Promise<ConciergeOwner | null>,
  caller: ActionCaller,
  content: NotifyContent | undefined,
): Promise<SendOutcome> {
  const recipient = await notifyRecipient(caller, ownerOfChat);
  if (recipient === undefined) return notify.send(content);
  return notify.send({ ...content, recipient });
}

/**
 * The main-process `NotifyService` for `send_notification`: it reads the
 * calling action's context, which a worker's call carries over IPC instead.
 */
export function callerNotifyService(
  notify: { send(content?: SystemNotifyContent): Promise<SendOutcome> },
  ownerOfChat: (chatId: string) => Promise<ConciergeOwner | null>,
): NotifyService {
  return {
    send: (content) =>
      sendForCaller(notify, ownerOfChat, actionCaller(actionExecutionContext.getStore()), content),
  };
}
