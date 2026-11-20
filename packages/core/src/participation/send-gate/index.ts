// The send gate: may a message an agent wrote go out. Rules:
// docs/domains/participation.md#send-gate.
import type { BondLevel } from "@rome-os/app-runtime";

/** A message an agent wants to send, as the send gate reads it. The text is
 *  not part of it: a gate judges where and to whom, never what. */
export interface SendRequest {
  /** The chat the message goes to. */
  destination: { connectionId: string; chatId: string };
  /** People's answer for the sender of the message this one answers, or null
   *  when it is nobody. Others in the chat may read it too: the gate is not told. */
  recipient: { bondLevel: BondLevel } | null;
  /** The agent that wrote the message. */
  author: { agentName: string };
}

/**
 * - `send`: the message goes out as it is.
 * - `check`: the caller runs Envoy on it first.
 * - `ask_guardian`: the message waits for the guardian in Approvals.
 * - `refuse`: the message never goes out.
 */
export type SendDecision = "send" | "check" | "ask_guardian" | "refuse";

/** Pure: no model call, no send, no storage. The same request always gets the
 *  same decision. */
export type SendGate = (request: SendRequest) => SendDecision;

export { guardedSend } from "./guarded-send.js";
