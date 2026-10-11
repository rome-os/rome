import { sessionKeyChannel } from "./agent-session-key.js";

const GUARDIAN_FACING_CHANNELS = new Set([
  "webchat",
  "telegram",
  "telegram_user",
  "whatsapp",
  "discord",
  "wechat",
]);

export function isGuardianFacingChannel(channelThreadKey: string): boolean {
  return GUARDIAN_FACING_CHANNELS.has(sessionKeyChannel(channelThreadKey) ?? "");
}
