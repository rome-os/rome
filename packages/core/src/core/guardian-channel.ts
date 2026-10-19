import type { ServiceOfChannel } from "../db/repositories/channel-records.js";
import { sessionKeyChannel } from "./agent-session-key.js";

const GUARDIAN_FACING_CHANNELS = new Set([
  "webchat",
  "telegram",
  "telegram_user",
  "whatsapp",
  "discord",
  "wechat",
]);

/** Whether the key's channel is on a guardian-facing service. A key carries
 *  its channel's id, and only a service's first channel has the service's
 *  name as its id, so `serviceOf` must map later channels to their service. */
export function isGuardianFacingChannel(
  channelThreadKey: string,
  serviceOf: ServiceOfChannel = (channel) => channel,
): boolean {
  return GUARDIAN_FACING_CHANNELS.has(serviceOf(sessionKeyChannel(channelThreadKey) ?? ""));
}
