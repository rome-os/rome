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

/** The chat rules the wake gate applies. Core has already resolved each to
 *  the value the chat runs on: its kind's fixed value, the guardian's choice
 *  where the kind offers the rule, or the default (chat-settings/rules.ts). */
export function chatRules({ effective }: ChatSettingsSnapshot): ChatRules {
  return {
    enabled: effective.enabled,
    replyRule: effective.activation.mode,
    botMessages: effective.activation.botMessages,
    whenOthersMentioned: effective.activation.whenOthersMentioned,
  };
}
