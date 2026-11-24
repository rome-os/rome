import type { SendGate } from "./index.js";

/** A message into any chat of an account that serves its workspace goes out
 *  unchecked, the woken chat or another: whoever reads it there is a member
 *  of the workspace the agent serves. On any other account `otherwise`
 *  decides. */
export function workspaceSend(
  servesWorkspace: (connectionId: string) => boolean,
  otherwise: SendGate,
): SendGate {
  return (request) =>
    servesWorkspace(request.destination.connectionId) ? "send" : otherwise(request);
}
