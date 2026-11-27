import type { ConnectionKindOfChannel } from "../db/repositories/channel-records.js";
import { sessionKeyChannel } from "./agent-session-key.js";

const WAKE_UP_CHANNELS = new Set(["webchat", "telegram", "telegram_user", "whatsapp", "discord"]);

/** Whether the key's channel is on a connection kind a wake-up can be scheduled back into. A key carries
 *  its channel's id, and only a connection kind's first channel has the connection kind's
 *  name as its id, so `connectionKindOf` must map later channels to their connection kind. */
export function takesWakeUps(
  channelThreadKey: string,
  connectionKindOf: ConnectionKindOfChannel = (channel) => channel,
): boolean {
  return WAKE_UP_CHANNELS.has(connectionKindOf(sessionKeyChannel(channelThreadKey) ?? ""));
}
