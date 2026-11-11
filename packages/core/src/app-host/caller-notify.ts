// Whose phone `send_notification` rings: the owner of a private chat, else the
// one person the turn acts for. In a shared chat with no such person it sends
// nothing. A visitor's call never reaches the guardian:
// docs/architecture/notification-delivery.md.
import type { SessionActor } from "../access/session-actor.js";
import { WEBCHAT_CHANNEL } from "../webchat/dashboard-account.js";
import { recipientOf } from "../concierge/owners.js";
import { GUARDIAN_OWNER, type ConciergeOwner } from "../webchat/owner.js";
import type {
  NotifyContent,
  NotifyService,
  SendOutcome,
  SystemNotifyContent,
} from "../lib/notify-client.js";
import { actionExecutionContext, type ActionExecutionStore } from "../apps/actions/context.js";

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

/** Whom a call's push goes to: `recipient` names a visitor, and none names the guardian. */
export type NotifyTarget = { recipient?: string } | "unknown";

/**
 * Whom a call's push goes to. A chat private to one person (a Concierge chat,
 * its task chats) rings that person. Otherwise the one person the turn acts
 * for, whoever owns the chat: a visitor in a chat they share with the
 * guardian or another visitor rings only themselves. A call in a shared chat
 * with no such person (no one acted, or more than one person's input is in
 * the turn) is `"unknown"` and sends nothing: it never falls back to the
 * chat's owner or the guardian. A call with no chat rings the guardian.
 */
export async function notifyRecipient(
  caller: ActionCaller,
  privateOwnerOf: (chatId: string) => Promise<ConciergeOwner | null>,
): Promise<NotifyTarget> {
  const owner = caller.chatId ? await privateOwnerOf(caller.chatId) : null;
  if (owner) return { recipient: recipientOf(owner) };
  if (caller.actor?.kind === "visitor") return { recipient: caller.actor.accountId };
  if (caller.actor?.kind === "guardian") return { recipient: recipientOf(GUARDIAN_OWNER) };
  return caller.chatId ? "unknown" : { recipient: recipientOf(GUARDIAN_OWNER) };
}

/** Sends `content` to the person `caller` stands for; sends nothing when that is unknown. */
export async function sendForCaller(
  notify: { send(content?: SystemNotifyContent): Promise<SendOutcome> },
  privateOwnerOf: (chatId: string) => Promise<ConciergeOwner | null>,
  caller: ActionCaller,
  content: NotifyContent | undefined,
): Promise<SendOutcome> {
  const target = await notifyRecipient(caller, privateOwnerOf);
  if (target === "unknown") return { kind: "recipient_unknown" };
  if (target.recipient === undefined) return notify.send(content);
  return notify.send({ ...content, recipient: target.recipient });
}

/**
 * The main-process `NotifyService` for `send_notification`: it reads the
 * calling action's context, which a worker's call carries over IPC instead.
 */
export function callerNotifyService(
  notify: { send(content?: SystemNotifyContent): Promise<SendOutcome> },
  privateOwnerOf: (chatId: string) => Promise<ConciergeOwner | null>,
): NotifyService {
  return {
    send: (content) =>
      sendForCaller(
        notify,
        privateOwnerOf,
        actionCaller(actionExecutionContext.getStore()),
        content,
      ),
  };
}
