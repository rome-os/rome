import type { ChatRef, ChatSettingsSnapshot } from "@rome-os/app-runtime";
import type { Policy } from "../../types.js";
import type { ConnectionKindOfChannel } from "../../db/repositories/channel-records.js";
import { type ChatWakeSettings, chatSettingsWake } from "./chat-settings-wake.js";
import type { WakeGateFor } from "./index.js";

const DEFAULT_LEVELS = ["guardian"];

/** Where the wake gate's settings are read from. */
export interface WakeGateLoaderDeps {
  chatSettings(chat: ChatRef): Promise<ChatSettingsSnapshot>;
  bondLevelsSetting(key: "trustedBondLevels" | "replyToBondLevels"): Promise<string[] | null>;
  policies(): Promise<Policy[]>;
  connectionKindOf: ConnectionKindOfChannel;
}

/** Builds each chat's wake gate from its current settings. Both bond-level
 *  settings default to the guardian alone. */
export function wakeGateLoader(deps: WakeGateLoaderDeps): WakeGateFor {
  return async ({ chat }) => {
    const [snapshot, trusted, replyTo, policies] = await Promise.all([
      deps.chatSettings(chat),
      deps.bondLevelsSetting("trustedBondLevels"),
      deps.bondLevelsSetting("replyToBondLevels"),
      deps.policies(),
    ]);
    return chatSettingsWake({
      ...chatRules(snapshot),
      trustedLevels: trusted ?? DEFAULT_LEVELS,
      replyToLevels: replyTo ?? DEFAULT_LEVELS,
      policies,
      connectionKindOf: deps.connectionKindOf,
    });
  };
}

type ChatRules = Pick<
  ChatWakeSettings,
  "enabled" | "replyRule" | "botMessages" | "whenOthersMentioned"
>;

/** The chat's settings the wake gate applies. A setting the chat's connection
 *  does not offer wakes on every message, as it did before the gate applied it. */
export function chatRules({ effective, supportedFields }: ChatSettingsSnapshot): ChatRules {
  const offers = (field: ChatSettingsSnapshot["supportedFields"][number]) =>
    supportedFields.includes(field);
  return {
    enabled: effective.enabled,
    replyRule: offers("activation.mode") ? effective.activation.mode : "all",
    botMessages: offers("activation.botMessages") ? effective.activation.botMessages : "all",
    whenOthersMentioned: offers("activation.whenOthersMentioned")
      ? effective.activation.whenOthersMentioned
      : "respond",
  };
}
