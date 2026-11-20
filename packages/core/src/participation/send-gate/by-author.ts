import { alwaysSend } from "./always-send.js";
import { guardedSend } from "./guarded-send.js";
import type { SendGate } from "./index.js";

const PROVIDERS = { guardedSend, alwaysSend } as const;

/** The send gate of the agent that wrote each message, as its definition
 *  names it. An agent that names none, or one not loaded, gets `guardedSend`. */
export function sendGateByAuthor(
  providerOf: (agent: string) => keyof typeof PROVIDERS | undefined,
): SendGate {
  return (request) => PROVIDERS[providerOf(request.author.agentName) ?? "guardedSend"](request);
}
