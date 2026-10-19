import type { SettingsRepository } from "../../db/repositories/settings.js";
import { createLogger } from "../../logger.js";

const log = createLogger("reply-streaming");

/**
 * The guardian setting that turns reply streaming on, kept under Experimental
 * features in Advanced settings. Any value but `true` leaves Rome sending each
 * reply whole.
 */
export const ENABLE_REPLY_STREAMING_SETTING_KEY = "enableReplyStreaming";

/**
 * Whether reply streaming is on. Each call reads the setting, so a change
 * applies to the next reply and the next send without a restart. A setting
 * that cannot be read counts as off.
 */
export type ReplyStreamingSwitch = () => Promise<boolean>;

export function replyStreamingSwitch(
  settings: Pick<SettingsRepository, "get">,
): ReplyStreamingSwitch {
  return async () => {
    try {
      return (await settings.get(ENABLE_REPLY_STREAMING_SETTING_KEY)) === true;
    } catch (error) {
      log.warn("reply streaming setting unreadable, treating it as off", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };
}
