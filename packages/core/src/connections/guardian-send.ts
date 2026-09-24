// Whether the send in progress is one the guardian made by hand.
//
// Some talkers send on the guardian's own account, such as personal WeChat.
// Every agent path reaches a talker through the same `TalkRouter.send`: worker
// RPC, `send_message`, backend turns, pairing notices. An argument or a flag on
// the call could be set by any of them. This scope can only be opened by the
// code that imports `asGuardian`, and only `sendToTarget` in `people/send.ts`
// does, around one `talkRouter.send` call. A talker on the guardian's own
// account refuses unless `consumeGuardianSend(message)` answers true.
//
// `AsyncLocalStorage` hands its store to every continuation created inside the
// scope, including a timer, a connection start, or an inbound delivery the
// talker kicks off while the send is still in flight. So the store is a token,
// not a flag: it answers true once, and only for the very message object the
// People route handed the router. An agent's send in that window carries its
// own message object and reads false, and so does any read after the talker
// consumed the token or after the call settled.

import { AsyncLocalStorage } from "node:async_hooks";
import type { OutgoingMessage } from "@rome-os/app-runtime";

interface GuardianSend {
  message: OutgoingMessage;
  open: boolean;
}

const scope = new AsyncLocalStorage<GuardianSend>();

/** Run one guardian-initiated send of `message`. Only `people/send.ts` may call this. */
export async function asGuardian<T>(message: OutgoingMessage, fn: () => Promise<T>): Promise<T> {
  const send: GuardianSend = { message, open: true };
  try {
    return await scope.run(send, fn);
  } finally {
    send.open = false;
  }
}

/**
 * True at most once per `asGuardian` call, and only for the message it was
 * opened with. A talker calls it synchronously at the top of `send`, before
 * any await, with the message it was handed.
 */
export function consumeGuardianSend(message: OutgoingMessage): boolean {
  const send = scope.getStore();
  if (!send?.open || send.message !== message) return false;
  send.open = false;
  return true;
}
