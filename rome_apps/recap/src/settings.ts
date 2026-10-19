import type { SettingsRepository } from "@rome-os/app-runtime";

export const RECAP_ENABLED_SETTING = "recap.enabled";
export const RECAP_CREATE_AUDIO_SETTING = "recap.createAudio";
export const RECAP_THRESHOLD_SETTING = "recap.threshold";
export const RECAP_AUDIO_SPEED_SETTING = "recap.audioSpeed";

export type RecapThreshold = "short" | "medium" | "long";
export type RecapAudioSpeed = "slower" | "normal" | "faster" | "fastest";

export const RECAP_SCORE_THRESHOLDS: Record<RecapThreshold, number> = {
  short: 400,
  medium: 1000,
  long: 2000,
};

export const RECAP_AUDIO_SPEED_RATES: Record<RecapAudioSpeed, string> = {
  slower: "-15%",
  normal: "default",
  faster: "+15%",
  fastest: "+30%",
};

export interface RecapSettings {
  enabled: boolean;
  createAudio: boolean;
  threshold: RecapThreshold;
  audioSpeed: RecapAudioSpeed;
}

export const DEFAULT_RECAP_SETTINGS: RecapSettings = {
  enabled: false,
  createAudio: false,
  threshold: "medium",
  audioSpeed: "faster",
};

export async function getRecapSettings(
  settingsRepo: Pick<SettingsRepository, "get"> | undefined,
): Promise<RecapSettings> {
  const [storedEnabled, storedCreateAudio, storedThreshold, storedAudioSpeed] = await Promise.all([
    settingsRepo?.get<unknown>(RECAP_ENABLED_SETTING),
    settingsRepo?.get<unknown>(RECAP_CREATE_AUDIO_SETTING),
    settingsRepo?.get<unknown>(RECAP_THRESHOLD_SETTING),
    settingsRepo?.get<unknown>(RECAP_AUDIO_SPEED_SETTING),
  ]);
  return {
    enabled: typeof storedEnabled === "boolean" ? storedEnabled : DEFAULT_RECAP_SETTINGS.enabled,
    createAudio:
      typeof storedCreateAudio === "boolean"
        ? storedCreateAudio
        : DEFAULT_RECAP_SETTINGS.createAudio,
    threshold: isRecapThreshold(storedThreshold)
      ? storedThreshold
      : DEFAULT_RECAP_SETTINGS.threshold,
    audioSpeed: isRecapAudioSpeed(storedAudioSpeed)
      ? storedAudioSpeed
      : DEFAULT_RECAP_SETTINGS.audioSpeed,
  };
}

export async function setRecapSettings(
  settingsRepo: Pick<SettingsRepository, "set">,
  settings: RecapSettings,
): Promise<void> {
  await Promise.all([
    settingsRepo.set(RECAP_ENABLED_SETTING, settings.enabled),
    settingsRepo.set(RECAP_CREATE_AUDIO_SETTING, settings.createAudio),
    settingsRepo.set(RECAP_THRESHOLD_SETTING, settings.threshold),
    settingsRepo.set(RECAP_AUDIO_SPEED_SETTING, settings.audioSpeed),
  ]);
}

export function isRecapThreshold(value: unknown): value is RecapThreshold {
  return value === "short" || value === "medium" || value === "long";
}

export function isRecapAudioSpeed(value: unknown): value is RecapAudioSpeed {
  return value === "slower" || value === "normal" || value === "faster" || value === "fastest";
}
