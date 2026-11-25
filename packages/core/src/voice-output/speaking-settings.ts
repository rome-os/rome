// The voice a voice conversation speaks in, and how fast, as Settings picks
// them. Every conversation reads them as it starts, on any client.

import {
  DEFAULT_VOICE_CONVERSATION_SETTINGS,
  type VoiceConversationSettings,
  voiceConversationSettingsSchema,
} from "@rome/api-types/voice-conversation";
import type { SettingsRepository } from "../db/repositories/settings.js";

export const VOICE_SPEAKING_SETTING_KEY = "voiceMode.speaking";

/** The picked voice and speed, or the defaults when none were picked or the stored ones no longer fit. */
export async function readSpeakingSettings(
  settings: Pick<SettingsRepository, "get">,
): Promise<VoiceConversationSettings> {
  const stored = await settings.get<unknown>(VOICE_SPEAKING_SETTING_KEY).catch(() => null);
  const parsed = voiceConversationSettingsSchema.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_VOICE_CONVERSATION_SETTINGS;
}
