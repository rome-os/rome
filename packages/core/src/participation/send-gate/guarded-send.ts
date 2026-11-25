import type { SendGate } from "./index.js";

/** A message into a chat that answers everyone goes out, whoever it answers.
 *  Elsewhere a message answering the guardian goes out, and Envoy checks one
 *  answering anyone else, so the guardian's message answered in a group goes
 *  out unchecked though others read the reply. */
export const guardedSend: SendGate = ({ destination, recipient }) =>
  destination.answers === "everyone" || recipient?.bondLevel === "guardian" ? "send" : "check";
