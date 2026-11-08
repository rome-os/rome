import type { SettingsRepository } from "../../../db/repositories/settings.js";
import type { ModelTier } from "../../domain/model-tier.js";
import type { TierModels, TierModelsSetting } from "../../domain/model-resolution.js";

/** The stored name of the guardian's tier models. */
export const TIER_MODEL_MAPPINGS_SETTING_KEY = "tierModelMappings";

const PROVIDERS = ["anthropic", "openai"] as const;
const TIERS: readonly ModelTier[] = ["large", "medium", "small"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the guardian's tier models from settings. Settings can also be written
 * outside the dashboard, so malformed or blank values read as absent rather
 * than breaking model resolution. Values are trimmed here as well as in the
 * dashboard.
 */
export function createTierModelsSetting(
  settingsRepo: Pick<SettingsRepository, "get">,
): TierModelsSetting {
  return {
    async read() {
      const value = await settingsRepo.get<unknown>(TIER_MODEL_MAPPINGS_SETTING_KEY);
      const tierModels: TierModels = {};
      if (!isRecord(value)) return tierModels;
      for (const providerId of PROVIDERS) {
        const models = value[providerId];
        if (!isRecord(models)) continue;
        for (const tier of TIERS) {
          const model = models[tier];
          if (typeof model === "string" && model.trim()) {
            tierModels[providerId] = { ...tierModels[providerId], [tier]: model.trim() };
          }
        }
      }
      return tierModels;
    },
  };
}
