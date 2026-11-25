// A chat switched off is not heard: none of its messages are recorded, and
// none wakes an agent. A stop said to Rome's account there is still heard, so
// a turn started before the chat was switched off can be stopped.
// Vocabulary: docs/domains/participation.md#wake-gate, docs/domains/chats.md#chat-rule.
//
// Connections hand over every message, in a chat switched off too. Rome drops
// them here, before Chats records them.

import { type ChannelMessage, isStopCommand } from "@rome-os/app-runtime";
import type { KindChatRules } from "./rules.js";
import type { ChatSettingsService } from "./service.js";

export interface SwitchedOffChatsDeps {
  settings: Pick<ChatSettingsService, "get">;
  /** The chat rules a kind of connection declares, or undefined for a kind
   *  Rome has not registered. */
  rulesOf: (connectionKind: string) => KindChatRules | undefined;
}

/**
 * Whether Rome hears `message`, which arrived on Connection `connectionId`:
 * false when it was said in a chat switched off, unless it is a stop said to
 * Rome's account. A kind whose chats cannot be switched off is always heard,
 * without reading its chats' settings.
 */
export function heardUnlessSwitchedOff(
  deps: SwitchedOffChatsDeps,
): (connectionId: string, connectionKind: string, message: ChannelMessage) => Promise<boolean> {
  return async (connectionId, connectionKind, message) => {
    if (!deps.rulesOf(connectionKind)?.offers.includes("enabled")) return true;
    const snapshot = await deps.settings.get({ connectionId, chatId: message.chatId });
    if (!snapshot.supportedFields.includes("enabled") || snapshot.effective.enabled) return true;
    return isStopSaidToRome(message);
  };
}

/** Whether `message` is a stop said to Rome's account: a direct message, a
 *  mention, a reply to it, or a message in a thread it started. */
function isStopSaidToRome(message: ChannelMessage): boolean {
  const said = message.addressing !== undefined && message.addressing !== "ambient";
  return said && isStopCommand(message.text);
}
