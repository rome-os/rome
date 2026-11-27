// The wake gate: does a message wake the agent. Rules:
// docs/domains/participation.md#wake-gate.
import type { ChatRef, MessageAddressing } from "@rome-os/app-runtime";

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
}

/**
 * - `wake`: the agent starts a turn on the message.
 * - `quiet`: the message stays in the record and wakes nobody.
 * - `block`: the same, because a policy blocks the chat.
 */
export type WakeDecision = "wake" | "quiet" | "block";

/** Pure: no model call, no send, no storage. The same message always gets the
 *  same decision: whoever sent it was let in before the gate is asked. */
export type WakeGate = (message: WakeMessage) => WakeDecision;

/** The wake gate for a chat, built from the settings current when it is
 *  asked for. Ask again for each message, so a changed setting applies. */
export type WakeGateFor = (request: { chat: ChatRef }) => Promise<WakeGate>;

export { chatSettingsWake, type ChatWakeSettings } from "./chat-settings-wake.js";
export { chatRules, wakeGateLoader, type WakeGateLoaderDeps } from "./load.js";
