import type { SendGate } from "./index.js";

/** A message answering the guardian goes out, and Envoy checks one answering
 *  anyone else. The destination is not read, so the guardian's message
 *  answered in a group goes out unchecked though others read the reply. */
export const guardedSend: SendGate = ({ recipient }) =>
  recipient?.bondLevel === "guardian" ? "send" : "check";
