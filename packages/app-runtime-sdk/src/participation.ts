// When an agent takes part in a chat: the wake gate and the send gate, as an
// app asks them. Rules: docs/domains/participation.md.
import type { BondLevel, ChatRef } from "./index.js";

/** A message as the wake gate reads it. The text is not part of it: a gate
 *  judges where and from whom, never what. */
export interface WakeMessage {
  /** The connection that carried the message. */
  connectionId: string;
  /** The chat it was said in, as that connection names it. */
  chatId: string;
  /** The channel name it arrived on, which channel policies name. */
  channel: string;
  /** A direct message, or a group, channel or other chat with more than one reader. */
  place: "direct" | "group";
  /** The chat's or thread's name, which thread policies name. */
  threadName?: string;
}

/** People's answer for the account that said the message. */
export interface WakeSender {
  /** The linked person, or null when the account is linked to nobody. */
  person: { id: string; bondLevel: BondLevel } | null;
}

/**
 * - `wake`: the agent starts a turn on the message.
 * - `quiet`: the message stays in the record and wakes nobody.
 * - `block`: the same, because a policy blocks the sender or chat.
 * - `review`: the caller runs the sentinel, which ignores, replies or wakes the agent.
 */
export type WakeDecision = "wake" | "quiet" | "block" | "review";

/** Pure: no model call, no send, no storage. The same message from the same
 *  sender always gets the same decision. */
export type WakeGate = (message: WakeMessage, sender: WakeSender) => WakeDecision;

/** The wake gate for a chat and the agent that would wake, built from the
 *  settings current when it is asked for. The agent's definition picks the
 *  provider, and an agent that names none, or no agent, gets the chat's
 *  settings. Ask again for each message, so a changed setting applies. */
export type WakeGateFor = (request: { chat: ChatRef; agent?: string }) => Promise<WakeGate>;

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
  };
  /** People's answer for the sender of the message this one answers, or null
   *  when it is nobody. Others in the chat may read it too: the gate is not told. */
  recipient: { bondLevel: BondLevel } | null;
  /** The agent that wrote the message. Its definition picks the provider. */
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

/** The gates a host hands an app's actions and its channel-message hook. A
 *  host that predates them passes neither. */
export interface ParticipationDeps {
  wakeGateFor?: WakeGateFor;
  sendGate?: SendGate;
}
