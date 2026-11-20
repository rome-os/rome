import type { SendGate } from "./index.js";

/** A message to the guardian goes out, and Envoy checks one to anyone else. */
export const guardedSend: SendGate = ({ recipient }) =>
  recipient?.bondLevel === "guardian" ? "send" : "check";
