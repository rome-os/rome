// Sending to an account: everything that has to be true before a message is
// handed to a channel. Vocabulary: docs/concepts/messaging.md#sending. The wire
// shapes are the message contract's (`@rome/api-types/message`).
//
// Saying the message is `chats/send.ts`'s, which takes a place. This module
// finds the place: the direct message that reaches the account a send names.
//
// A send names its account. There is no entry point here that takes a person
// and picks one of their accounts, because every rule that could pick decides
// who receives a message on evidence too thin to carry it: reaching for another
// channel when one is down sends somewhere nobody chose.
//
// Nor does Rome pick among its own accounts on one platform. A send goes out
// from the one account Rome holds on the account's platform (`sendersOf`), or
// from the one the send names. With several and none named, the send is
// refused rather than sent from an account nobody chose.
//
// Whether a channel can be sent to at all is the channel's own declaration:
// its `send` port's `direct`. A channel whose sending cannot reach an account
// directly cannot be written to from here, without a read-only flag threaded
// through anything.

import type { Account, ChatId } from "@rome-os/app-runtime";
import { AccountNotConnected, type ChannelSend } from "./connected-accounts/connected-account.js";
import { chatKey, placeIn, type Place } from "./place.js";
import type { RefusedState, Sender, SendResult } from "./send.js";
import {
  senderNamed,
  soleSender,
  sendersOf,
  type SendDeps,
  type SendIntoPlaceDeps,
} from "../connections/send.js";

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
 * the port rejects with {@link AccountNotConnected} then, as a send would.
 */
async function sendStateOf(
  deps: SendDeps,
  account: Account,
  from?: string,
): Promise<{ state: RefusedState } | { state: "yes"; target: SendTarget }> {
  const senders = from === undefined ? sendersOf(deps, account.platform) : [from];
  // With no sender named, Rome holds no account on the platform, or several.
  // No Connection answers for the account as such, and connecting or removing
  // one of Rome's accounts is what settles it, so it reads as not connected.
  const name = senders.length === 1 ? senders[0] : undefined;
  if (name === undefined) return { state: "not-connected" };
  const channel = deps.channels.find((candidate) => candidate.name === name);
  // A channel Rome does not know is one no connection answers for.
  if (!channel) return { state: "not-connected" };
  const send = channel.send;
  const direct = send?.direct ?? null;
  if (!send || !direct) return { state: "unsupported" };

  // A channel that throws asking for a thread is a channel that could not
  // produce one, which is the same answer as null: `no-conversation`, not a
  // 500.
  let chatId: ChatId | null;
  try {
    chatId = await direct.chatFor(account.id);
  } catch (err) {
    if (err instanceof AccountNotConnected) return { state: "not-connected" };
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
 * The direct message that reaches `account`, as a place a send can name, and
 * `as`, the sender whose channel found it. Absent `from`, Rome has to hold one
 * account on the platform. Refused with the account's send state, or
 * `invalid` when `from` is none of Rome's accounts there.
 *
 * Its key is the address the sender's channel holds for the direct message,
 * which is the platform's own id for it over today's storage, so the send has
 * to go out as `as`: another account's channel may hold another address.
 * With `recording`, the direct message is held in Chats from here on.
 */
export async function directPlace(
  deps: Pick<SendIntoPlaceDeps, keyof SendDeps | "accountOf" | "recording">,
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
  const address = resolution.target.chatId;
  if (deps.recording) {
    // Held in Chats before the send, so the send finds the direct message at
    // the address and says the line there, not in a group.
    const { adapters, chats } = deps.recording;
    // The channel may have come back as another account while the lookup
    // ran, and the address is this one's: keep it under no other.
    if ("id" in as && adapters.knownAccountOn(sender)?.id !== as.id) {
      return { ok: false, send: "not-connected" };
    }
    chats.start(adapters.directMessageReached(sender, account.id, address), "dm", null);
  }
  return { ok: true, place: placeIn(chatKey(account.platform, address)), as };
}
