// Sending to a person: which of their accounts a message may go to, and
// everything that has to be true before one is handed to a channel.
//
// Vocabulary: docs/concepts/people.md. The wire shapes are the People
// contract's (`@rome/api-types/people`).
//
// Saying the message is `chats/send.ts`'s, which takes a place. This module
// finds the place: the direct message that reaches the account a send names.
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
// Nor does Rome pick among its own accounts on one platform. A link names the
// platform, and a send to it goes out from the one account Rome holds there
// (`sendersOf`), or from the one the send names. With several and none named,
// the send is refused rather than sent from an account nobody chose.
//
// Whether a channel can be sent to at all is the channel's own declaration:
// its `send` port's `direct`. A channel whose sending cannot reach an account
// directly cannot be written to from here, without a read-only flag threaded
// through anything.

import type { Account, ChatId } from "@rome-os/app-runtime";
import type { AccountSendState } from "@rome/api-types/people";
import { ChannelNotConnected, type ChannelSend } from "../channels/channel.js";
import { chatAt } from "../chats/adapter.js";
import { placeIn, type Place } from "../chats/place.js";
import {
  type Sender,
  senderNamed,
  soleSender,
  sendersOf,
  type RefusedState,
  type SendDeps,
  type SendIntoPlaceDeps,
  type SendResult,
} from "../chats/send.js";

export { sendersOf, type SendDeps };

/** A resolved target: the channel it is on, that channel's send port, and the
 *  conversation on it that reaches this account. It names the channel, not
 *  the Connection: the port finds the channel's Connection again when it
 *  sends. A channel holds at most one Connection, so that is the one the
 *  conversation was resolved on, unless the Connection was replaced in
 *  between. This is deliberate. */
interface SendTarget {
  channel: string;
  send: ChannelSend;
  chatId: ChatId;
}

export type Resolution = { ok: true; target: SendTarget } | { ok: false; send: RefusedState };

/**
 * Everything true before a body may be handed to a channel, or which of the
 * three ways it is not.
 *
 * Whether the channel does direct messaging is a synchronous read of its send
 * port. Only asking for the thread that reaches this account can reach a
 * provider, and it is also what says no Connection exists for the channel:
 * the port rejects with {@link ChannelNotConnected} then, as a send would.
 */
async function sendStateOf(
  deps: SendDeps,
  account: Account,
  from?: string,
): Promise<{ state: RefusedState } | { state: "yes"; target: SendTarget }> {
  const senders = from === undefined ? sendersOf(deps, account.platform) : [from];
  // With no sender named, Rome holds no account on the platform, or several.
  // No Connection answers for the link as such, and connecting or removing
  // an account is what settles it, so it reads as not connected.
  const name = senders.length === 1 ? senders[0] : undefined;
  if (name === undefined) return { state: "not-connected" };
  const channel = deps.channels.find((candidate) => candidate.name === name);
  // A channel Rome does not know is one no connection answers for.
  if (!channel) return { state: "not-connected" };
  const send = channel.send;
  const direct = send?.direct ?? null;
  if (!send || !direct) return { state: "unsupported" };

  // A channel that throws asking for a thread is a channel that could not
  // produce one, which is the same answer as null and the same answer the
  // person read already gives for this account. Letting it escape would make
  // the send path report a 500 where the read reported `no-conversation`, so
  // the two would disagree about one condition.
  let chatId: ChatId | null;
  try {
    chatId = await direct.chatFor(account.id);
  } catch (err) {
    if (err instanceof ChannelNotConnected) return { state: "not-connected" };
    chatId = null;
  }
  if (chatId === null) return { state: "no-conversation" };
  return { state: "yes", target: { channel: channel.name, send, chatId } };
}

/**
 * The target a send to `account` goes out on. `from` names the channel of
 * Rome's account it goes out from, and no other is tried. The caller has
 * checked it is one of `sendersOf` the account's platform. Absent, Rome has
 * to hold one account there.
 */
export async function resolveSendTarget(
  deps: SendDeps,
  account: Account,
  from?: string,
): Promise<Resolution> {
  const resolved = await sendStateOf(deps, account, from);
  return resolved.state === "yes"
    ? { ok: true, target: resolved.target }
    : { ok: false, send: resolved.state };
}

/**
 * Whether Rome can send to each of the given accounts, positionally: yes
 * when any of Rome's accounts on its platform can, and otherwise the first
 * one's reason.
 *
 * Only `chatFor` can reach a provider, and it is asked once per account and
 * sender — cheap on the channels in play, and the reason a channel that keys
 * threads separately has to be priced before it is added to a listing read. A
 * listing must not fail because one account of one person could not be priced.
 */
export async function readSendStates(
  deps: SendDeps,
  accounts: readonly Account[],
): Promise<AccountSendState[]> {
  // A listing names a handful of platforms across many links, and each answer
  // reads the channel records, so each platform is asked once.
  const senders = new Map<string, string[]>();
  const sendersOn = (platform: string) => {
    let found = senders.get(platform);
    if (!found) {
      found = sendersOf(deps, platform);
      senders.set(platform, found);
    }
    return found;
  };
  return await Promise.all(
    accounts.map(async (account) => {
      // Whether any of Rome's accounts there can reach it: a send names one,
      // and the page offers each.
      const states = await Promise.all(
        sendersOn(account.platform).map(
          async (from) => (await sendStateOf(deps, account, from)).state,
        ),
      );
      return states.includes("yes") ? "yes" : (states[0] ?? "not-connected");
    }),
  );
}

/**
 * The direct message that reaches `account`, as a place a send can name, and
 * `as`, the sender whose channel found it. Absent `from`, Rome has to hold one
 * account on the platform. Refused with the same state the person read
 * carries, or `invalid` when `from` is none of Rome's accounts there.
 *
 * Its key is the address the sender's channel holds for the direct message,
 * which is the platform's own id for it over today's storage, so the send has
 * to go out as `as`: another account's channel may hold another address.
 */
export async function directPlace(
  deps: Pick<SendIntoPlaceDeps, keyof SendDeps | "accountOf">,
  account: Account,
  from?: Account,
): Promise<{ ok: true; place: Place; as: Sender } | Extract<SendResult, { ok: false }>> {
  const sender =
    from === undefined
      ? soleSender(deps, account.platform)
      : senderNamed(deps, account.platform, from);
  if (sender === null) {
    return { ok: false, invalid: "Rome holds no account by that id that can send to this account" };
  }
  if (sender === undefined) return { ok: false, send: "not-connected" };
  // Taken before the lookup awaits: a disconnect meanwhile clears the record
  // of the channel's account, and the send must still go out as this one.
  const as: Sender = from ?? deps.accountOf?.(sender) ?? { channel: sender };
  const resolution = await resolveSendTarget(deps, account, sender);
  if (!resolution.ok) return { ok: false, send: resolution.send };
  const romeEnd = "channel" in as ? as.channel : as.id;
  const chat = chatAt(account.platform, resolution.target.chatId, { romeEnd, other: account.id });
  return { ok: true, place: placeIn(chat), as };
}
