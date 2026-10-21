import type { ConnectionKindOfChannel } from "../db/repositories/channel-records.js";
import { sessionKeyChannel } from "./agent-session-key.js";

const GUARDIAN_FACING_CHANNELS = new Set([
  "webchat",
  "telegram",
  "telegram_user",
  "whatsapp",
  "discord",
  "wechat",
]);

/** Whether the key's channel is on a guardian-facing connection kind. A key carries
 *  its channel's id, and only a connection kind's first channel has the connection kind's
 *  name as its id, so `connectionKindOf` must map later channels to their connection kind. */
export function isGuardianFacingChannel(
  channelThreadKey: string,
  connectionKindOf: ConnectionKindOfChannel = (channel) => channel,
): boolean {
  return GUARDIAN_FACING_CHANNELS.has(connectionKindOf(sessionKeyChannel(channelThreadKey) ?? ""));
}
