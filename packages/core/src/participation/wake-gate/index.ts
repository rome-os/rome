// The wake gate: does a message wake the agent. Rules:
// docs/domains/participation.md#wake-gate.
import type { BondLevel, ChatRef, MessageAddressing } from "@rome-os/app-runtime";

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
  /** How the message addressed Rome's account, as the connection reports it. */
  addressing?: MessageAddressing;
  /** Another bot sent it. A webhook linked to a person speaks for that person. */
  fromBot?: boolean;
  /** It mentions someone, and none of them is Rome's account. */
  mentionsOthers?: boolean;
  /** The connection opened its account to its workspace's other members, and
   *  the sender is one, as the connection reports it. */
  openToMembers?: boolean;
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
 * - `member_review`: the same, for a sender answered only because their
 *   connection is open to its members. Only the sentinel's own ESCALATE wakes
 *   the agent, and a sentinel that fails or cannot be read answers nothing.
 */
export type WakeDecision = "wake" | "quiet" | "block" | "review" | "member_review";

/** Pure: no model call, no send, no storage. The same message from the same
 *  sender always gets the same decision. */
export type WakeGate = (message: WakeMessage, sender: WakeSender) => WakeDecision;

/** The wake gate for a chat, built from the settings current when it is
 *  asked for. Ask again for each message, so a changed setting applies. */
export type WakeGateFor = (request: { chat: ChatRef }) => Promise<WakeGate>;

export { chatSettingsWake, type ChatWakeSettings } from "./chat-settings-wake.js";
export { chatRules, wakeGateLoader, type WakeGateLoaderDeps } from "./load.js";
