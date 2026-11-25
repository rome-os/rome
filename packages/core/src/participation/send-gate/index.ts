// The send gate: may a message an agent wrote go out. Rules:
// docs/domains/participation.md#send-gate.
import type { BondLevel } from "@rome-os/app-runtime";

/** A message an agent wants to send, as the send gate reads it. The text is
 *  not part of it: a gate judges where and to whom, never what. */
export interface SendRequest {
  /** Where the message goes. A gate reads what it needs, and whether any of
   *  it reaches an agent's context is the caller's choice. */
  destination: {
    /** The connection that carries the message. */
    connectionId: string;
    /** The chat the message goes to, as that connection names it. */
    chatId: string;
    /** A direct message, or a group, channel or other chat with more than one reader. */
    place: "direct" | "group";
    /** The message goes to the chat the agent was woken in. */
    sameChatAsWake: boolean;
    /** Nobody but the guardian can read the message there. */
    onlyGuardianReads: boolean;
    /** The destination chat's rule on whom the agent answers
     *  (docs/domains/chats.md#answers-rule). Absent where the caller did not
     *  read it, which reads as `known_people`. */
    answers?: "known_people" | "everyone";
  };
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
