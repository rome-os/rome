// Sending to a person: which of their accounts a message may go to, and
// everything that has to be true before one is handed to a channel.
//
// Vocabulary: docs/concepts/people.md. The wire shapes are the People
// contract's (`@rome/api-types/people`).
//
// A send names its account. There is no entry point here that takes a person
// and picks for them, because every rule that could pick decides who receives
// a message on evidence too thin to carry it — a timeline entry names its
// channel and not its address, so "reply where they last wrote" cannot
// separate two numbers on one channel, and reaching for another channel when
// one is down sends somewhere nobody chose. `defaultSendAccount` in the
// contract offers surfaces a preselected account; it is a default rendered on
// screen, not a decision taken off it.
//
// Whether a channel can be sent to at all is the channel's own declaration:
// `talk.feature("directMessaging")`. A talker that does not offer it cannot be
// written to from here, which is how LinkedIn's mirrored inbox stays readable
// without a read-only flag threaded through anything.

import type { ConversationId, TalkRouter } from "@rome-os/app-runtime";
import type { AccountSendState } from "@rome/api-types/people";

export interface SendAccount {
  channel: string;
  channelUserId: string;
}

export interface SendDeps {
  talkRouter: Pick<TalkRouter, "list" | "feature" | "send">;
}

/** A resolved target: the connection to send on, and the conversation on it
 *  that reaches this account. */
export interface SendTarget {
  connectionId: string;
  conversationId: ConversationId;
}

export type Resolution = { ok: true; target: SendTarget } | { ok: false; send: RefusedState };

export type RefusedState = Exclude<AccountSendState, "yes">;

/**
 * The connection that answers for a channel, or null when none does.
 *
 * A lookup rather than a choice: `connections.service` carries a unique index
 * (`connections_service_unique`), so a service has at most one connection and
 * "which one is this account on" is a question that cannot arise.
 */
async function connectionFor(deps: SendDeps, channel: string): Promise<string | null> {
  const connections = await deps.talkRouter.list();
  return connections.find((connection) => connection.service === channel)?.connectionId ?? null;
}

/**
 * Everything true before a body may be handed to a talker, or which of the
 * three ways it is not.
 *
 * The two cheap answers come first and cost no provider call: whether the
 * channel is connected, and whether its talker does direct messaging at all.
 * Only the third — does a thread reaching this account exist — can be
 * expensive, and on the channels where the address is already the conversation
 * it is not.
 */
export async function resolveSendTarget(deps: SendDeps, account: SendAccount): Promise<Resolution> {
  const connectionId = await connectionFor(deps, account.channel);
  if (connectionId === null) return { ok: false, send: "not-connected" };

  const direct = deps.talkRouter.feature(connectionId, "directMessaging");
  if (!direct) return { ok: false, send: "unsupported" };

  // A channel that throws asking for a thread is a channel that could not
  // produce one, which is the same answer as null and the same answer the
  // person read already gives for this account. Letting it escape would make
  // the send path report a 500 where the read reported `no-conversation`, so
  // the two would disagree about one condition.
  const conversationId = await direct.conversationFor(account.channelUserId).catch(() => null);
  if (conversationId === null) return { ok: false, send: "no-conversation" };

  return { ok: true, target: { connectionId, conversationId } };
}

/**
 * Whether Rome can send to each of the given accounts, positionally.
 *
 * Over every account at once because it is read for a whole listing: the
 * connection list is read once for all of them rather than once per row, and
 * `feature` is a synchronous registry lookup. Only `conversationFor` can reach
 * a provider, and it is asked once per account — cheap on the channels in
 * play, and the reason a channel that keys threads separately has to be
 * priced before it is added to a listing read.
 */
export async function readSendStates(
  deps: SendDeps,
  accounts: readonly SendAccount[],
): Promise<AccountSendState[]> {
  if (accounts.length === 0) return [];

  const connections = await deps.talkRouter.list();
  const byService = new Map(connections.map((c) => [c.service, c.connectionId]));

  return await Promise.all(
    accounts.map(async (account): Promise<AccountSendState> => {
      const connectionId = byService.get(account.channel);
      if (connectionId === undefined) return "not-connected";
      const direct = deps.talkRouter.feature(connectionId, "directMessaging");
      if (!direct) return "unsupported";
      // A provider that throws here is a channel that cannot answer, which is
      // the same fact as one that answers null. A listing must not fail
      // because one account of one person could not be priced.
      const conversationId = await direct.conversationFor(account.channelUserId).catch(() => null);
      return conversationId === null ? "no-conversation" : "yes";
    }),
  );
}

/** What a channel said when it took the message: its own id for it, so the
 *  entry this becomes on the timeline can be recognized when it lands. */
export interface SendReceipt {
  messageId: string | null;
}

/**
 * Hand the text to the channel.
 *
 * Throws whatever the talker throws — the caller records the failure, because
 * only it knows which outbox row is waiting on the answer.
 */
export async function sendToTarget(
  deps: SendDeps,
  target: SendTarget,
  text: string,
): Promise<SendReceipt> {
  const receipt = await deps.talkRouter.send(target.connectionId, target.conversationId, { text });
  return { messageId: receipt.messageId ?? null };
}
