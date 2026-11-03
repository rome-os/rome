import type { SettingsRepository } from "../db/repositories/settings.js";
import type { AppManager } from "./manager.js";

/** Run before first-party reconciliation removes the legacy Recap lockfile entry. */
export async function preserveRecapOptOutAtBoot(
  appManager: Pick<AppManager, "readLockfileEntry">,
  settingsRepo: Pick<SettingsRepository, "set">,
): Promise<void> {
  const recap = await appManager.readLockfileEntry("recap");
  if (recap?.firstParty && !recap.enabled) {
    // System cannot be disabled, so the feature switch must carry this opt-out.
    await settingsRepo.set("recap.enabled", false);
  }
}
