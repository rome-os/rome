// Whether the send in progress is one the guardian made by hand.
//
// Some talkers send on the guardian's own account, such as personal WeChat.
// Every agent path reaches a talker through the same `TalkRouter.send`: worker
// RPC, `send_message`, backend turns, pairing notices. An argument or a flag on
// the call could be set by any of them. This scope can only be opened by the
// code that imports `asGuardian`, and only `sendToTarget` in `people/send.ts`
// does, around one `talkRouter.send` call. A talker on the guardian's own
// account refuses when `isGuardianSend()` is false.
//
// `AsyncLocalStorage` hands its store to every continuation created inside the
// scope, including a timer or a connection start the talker kicks off and that
// outlives the send. The store is therefore a live flag, closed when the call
// settles, so such work reads false once the send is over.

import { AsyncLocalStorage } from "node:async_hooks";

interface GuardianSend {
  open: boolean;
}

const scope = new AsyncLocalStorage<GuardianSend>();

/** Run one guardian-initiated send. Only `people/send.ts` may call this. */
export async function asGuardian<T>(fn: () => Promise<T>): Promise<T> {
  const send: GuardianSend = { open: true };
  try {
    return await scope.run(send, fn);
  } finally {
    send.open = false;
  }
}

/** True only while a send opened by `asGuardian` is still in progress. */
export function isGuardianSend(): boolean {
  return scope.getStore()?.open === true;
}
