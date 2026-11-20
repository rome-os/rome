import type { ChatRef } from "@rome-os/app-runtime";
import type { Policy } from "../../types.js";
import type { ConnectionKindOfChannel } from "../../db/repositories/channel-records.js";
import { chatSettingsWake } from "./chat-settings-wake.js";
import type { WakeGateFor } from "./index.js";

const DEFAULT_LEVELS = ["guardian"];

/** Where the wake gate's settings are read from. */
export interface WakeGateLoaderDeps {
  chatEnabled(chat: ChatRef): Promise<boolean>;
  bondLevelsSetting(key: "trustedBondLevels" | "replyToBondLevels"): Promise<string[] | null>;
  policies(): Promise<Policy[]>;
  connectionKindOf: ConnectionKindOfChannel;
}

/** Builds each chat's wake gate from its current settings. Both bond-level
 *  settings default to the guardian alone. */
export function wakeGateLoader(deps: WakeGateLoaderDeps): WakeGateFor {
  return async ({ chat }) => {
    const [enabled, trusted, replyTo, policies] = await Promise.all([
      deps.chatEnabled(chat),
      deps.bondLevelsSetting("trustedBondLevels"),
      deps.bondLevelsSetting("replyToBondLevels"),
      deps.policies(),
    ]);
    return chatSettingsWake({
      enabled,
      trustedLevels: trusted ?? DEFAULT_LEVELS,
      replyToLevels: replyTo ?? DEFAULT_LEVELS,
      policies,
      connectionKindOf: deps.connectionKindOf,
    });
  };
}
