import type { ConnectionKindOfChannel } from "../db/repositories/channel-records.js";

const GUARDIAN_FACING_CHANNELS = new Set([
  "webchat",
  "telegram",
  "telegram_user",
  "whatsapp",
  "discord",
  "wechat",
]);

/** Whether a channel is on a guardian-facing connection kind. Only a connection
 *  kind's first channel has the connection kind's name as its id, so
 *  `connectionKindOf` must map later channels to their connection kind. */
export function isGuardianFacingChannel(
  channel: string,
  connectionKindOf: ConnectionKindOfChannel = (name) => name,
): boolean {
  return GUARDIAN_FACING_CHANNELS.has(connectionKindOf(channel));
}
