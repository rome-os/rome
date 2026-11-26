// The voice a voice conversation speaks in, and how fast, as Settings picks
// them. Every conversation reads them as it starts, on any client.

import {
  DEFAULT_VOICE_CONVERSATION_SETTINGS,
  type VoiceConversationSettings,
  voiceConversationSettingsSchema,
} from "@rome/api-types/voice-conversation";
import type { SettingsRepository } from "../db/repositories/settings.js";

export const VOICE_SPEAKING_SETTING_KEY = "voiceMode.speaking";

/**
 * The picked voice and speed, or undefined when none were picked or the stored
 * ones no longer fit. A conversation without a pick speaks in the voice Rome
 * Cloud names, at its own pace.
 */
export async function readSpeakingPick(
  settings: Pick<SettingsRepository, "get">,
): Promise<VoiceConversationSettings | undefined> {
  const stored = await settings.get<unknown>(VOICE_SPEAKING_SETTING_KEY).catch(() => null);
  const parsed = voiceConversationSettingsSchema.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
}

/** The picked voice and speed as Settings shows them: the defaults until one is picked. */
export async function readSpeakingSettings(
  settings: Pick<SettingsRepository, "get">,
): Promise<VoiceConversationSettings> {
  return (await readSpeakingPick(settings)) ?? DEFAULT_VOICE_CONVERSATION_SETTINGS;
}
