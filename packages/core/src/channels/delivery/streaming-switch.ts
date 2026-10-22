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

/**
 * The guardian setting that chooses how a reply streams to Feishu, beside the
 * reply streaming switch, while the two styles are compared. Any value but
 * `card` streams as messages.
 */
export const FEISHU_STREAMING_STYLE_SETTING_KEY = "feishuReplyStreamingStyle";

/**
 * How a streamed reply shows on Feishu: `message` edits rich-text posts, which
 * Feishu lets be edited 20 times each, and `card` streams into cards, which
 * show the text as it is typed and take any number of edits.
 */
export type FeishuStreamingStyle = "message" | "card";

/** The Feishu streaming style, read for each message a reply creates. A
 *  setting that cannot be read counts as `message`. */
export function feishuStreamingStyle(
  settings: Pick<SettingsRepository, "get">,
): () => Promise<FeishuStreamingStyle> {
  return async () => {
    try {
      return (await settings.get(FEISHU_STREAMING_STYLE_SETTING_KEY)) === "card"
        ? "card"
        : "message";
    } catch (error) {
      log.warn("Feishu streaming style unreadable, streaming as messages", {
        error: error instanceof Error ? error.message : String(error),
      });
      return "message";
    }
  };
}
