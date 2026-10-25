import { lt as semverLt, valid as semverValid } from "semver";
import type { BuildInfo } from "../build-info.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { createLogger } from "../logger.js";

const log = createLogger("boot-version-report");

/** Settings KV key holding the release version that last completed boot. */
export const LAST_BOOTED_VERSION_KEY = "system.lastBootedVersion";

export interface BootVersionReport {
  /**
   * True when this boot's release version differs from the previously stored
   * one, a downgrade included. Compare `previousVersion` to tell them apart.
   */
  upgradedSinceLastBoot: boolean;
  /** The version stored by the previous versioned boot, or null on first boot. */
  previousVersion: string | null;
}

/**
 * Compare the running release version against the one recorded at the last
 * completed boot. Read-only: the stored version is advanced by
 * `commitBootVersion` only once startup is known-good, so a build that dies
 * mid-boot still reports the upgrade on its next successful boot. The returned
 * report is surfaced through `GET /api/build-info` so the dashboard can show
 * an "upgraded since last boot" notice (core has no system→guardian messaging
 * primitive, so the API response is the notification surface).
 *
 * Source runs (`version === null`) have no release identity: they report
 * nothing, and `commitBootVersion` leaves the stored value untouched so the
 * next *versioned* boot still compares against the last versioned one.
 *
 * Version reporting is observational — a settings read failure degrades to a
 * no-upgrade report rather than blocking boot.
 */
export async function reportBootVersion(
  settingsRepo: SettingsRepository,
  buildInfo: BuildInfo,
): Promise<BootVersionReport> {
  if (!buildInfo.version) {
    return { upgradedSinceLastBoot: false, previousVersion: null };
  }

  let previousVersion: string | null;
  try {
    previousVersion = await settingsRepo.get<string>(LAST_BOOTED_VERSION_KEY);
  } catch (err) {
    log.warn("could not read last booted version; upgrade notice suppressed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { upgradedSinceLastBoot: false, previousVersion: null };
  }
  const upgradedSinceLastBoot = previousVersion !== null && previousVersion !== buildInfo.version;
  if (previousVersion !== null && upgradedSinceLastBoot) {
    const transition = { from: previousVersion, to: buildInfo.version };
    // A rollback onto a newer release's database is the case worth an operator's
    // attention, so it logs apart from an upgrade.
    if (isOlderRelease(buildInfo.version, previousVersion)) {
      log.warn("rome downgraded since last boot", transition);
    } else {
      log.info("rome upgraded since last boot", transition);
    }
  }
  return { upgradedSinceLastBoot, previousVersion };
}

function isOlderRelease(version: string, than: string): boolean {
  const current = semverValid(version);
  const previous = semverValid(than);
  return current !== null && previous !== null && semverLt(current, previous);
}

/**
 * Record the running release version as the last completed boot. Call only
 * after startup has succeeded — committing earlier would mark a build that
 * dies mid-boot as "seen" and permanently suppress its upgrade notice.
 * Observational: a write failure is logged, never thrown.
 */
export async function commitBootVersion(
  settingsRepo: SettingsRepository,
  buildInfo: BuildInfo,
): Promise<void> {
  if (!buildInfo.version) return;
  try {
    await settingsRepo.set(LAST_BOOTED_VERSION_KEY, buildInfo.version);
  } catch (err) {
    log.warn("could not record booted version", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
