import type { SettingsRepository } from "../db/repositories/settings.js";
import { parseTimeZone } from "../lib/timezone.js";

/** The single global timezone the guardian configures (Rome is guardian-only).
 * Stored as a plain IANA string (e.g. "Asia/Tokyo") under this settings key. */
export const GUARDIAN_TIMEZONE_SETTING_KEY = "guardianTimezone";

/** The guardian's configured timezone for scheduling, falling back to the
 * host's IANA zone and then UTC. A blank/invalid stored value is ignored.
 * This is the zone a `floating` schedule resolves against. */
export async function resolveGuardianTimezone(
  settingsRepo: Pick<SettingsRepository, "get">,
): Promise<string> {
  const stored = parseTimeZone(await settingsRepo.get(GUARDIAN_TIMEZONE_SETTING_KEY));
  return stored ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

export type GuardianTimezoneWriteResult =
  | { status: "set"; tzid: string }
  | { status: "cleared" }
  | { status: "unchanged" }
  | { status: "invalid"; error: string };

export interface GuardianTimezoneWriteDeps {
  settingsRepo: Pick<SettingsRepository, "get" | "set" | "delete">;
  /** Reschedule every floating routine; called only when the effective zone changes. */
  reactivateFloating: () => Promise<void>;
}

/** The single write path for `guardianTimezone`. Validates the value,
 * persists it (or clears the override on blank/null back to the host/UTC
 * fallback), and reschedules floating routines when the effective zone changes.
 * Every caller — the settings route and onboarding — must go through this so the
 * scheduler never drifts from the stored zone. Returns `invalid` (without
 * writing) for a non-empty value that isn't a real IANA zone; the caller decides
 * whether to reject or skip. */
export async function applyGuardianTimezoneWrite(
  raw: unknown,
  deps: GuardianTimezoneWriteDeps,
): Promise<GuardianTimezoneWriteResult> {
  const previous = await deps.settingsRepo.get<string>(GUARDIAN_TIMEZONE_SETTING_KEY);
  const isClear = raw == null || (typeof raw === "string" && raw.trim() === "");
  if (isClear) {
    if (previous == null) return { status: "unchanged" };
    await deps.settingsRepo.delete(GUARDIAN_TIMEZONE_SETTING_KEY);
    await deps.reactivateFloating();
    return { status: "cleared" };
  }
  const next = parseTimeZone(raw);
  if (next === null) {
    return {
      status: "invalid",
      error: `${GUARDIAN_TIMEZONE_SETTING_KEY} must be a valid IANA timezone, e.g. "America/Los_Angeles"`,
    };
  }
  await deps.settingsRepo.set(GUARDIAN_TIMEZONE_SETTING_KEY, next);
  if (next !== previous) {
    await deps.reactivateFloating();
    return { status: "set", tzid: next };
  }
  return { status: "unchanged" };
}
