import type { SettingsRepository } from "../../../db/repositories/settings.js";
import {
  isDefaultProvider,
  type DefaultProviderSetting,
  type DefaultProviderState,
} from "../../domain/default-provider.js";

/** The stored name of the default provider and the note a removal left. */
const DEFAULT_MODEL_PROVIDER_SETTING_KEY = "defaultModelProvider";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads and writes the default provider in settings. Settings can be written
 * outside the dashboard, so a malformed value reads as none.
 */
export function createDefaultProviderSetting(
  settingsRepo: Pick<SettingsRepository, "get" | "set">,
): DefaultProviderSetting {
  return {
    async read() {
      const value = await settingsRepo.get<unknown>(DEFAULT_MODEL_PROVIDER_SETTING_KEY);
      if (!isRecord(value) || !isDefaultProvider(value.provider)) return { provider: null };
      const note = value.note;
      const state: DefaultProviderState = { provider: value.provider };
      if (
        isRecord(note) &&
        isDefaultProvider(note.from) &&
        isDefaultProvider(note.to) &&
        typeof note.at === "string"
      ) {
        state.note = { from: note.from, to: note.to, at: note.at };
      }
      return state;
    },
    async write(state) {
      await settingsRepo.set(DEFAULT_MODEL_PROVIDER_SETTING_KEY, state);
    },
  };
}
