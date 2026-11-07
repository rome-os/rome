// What an account's status, usage and held refusal amount to: the
// availability the account reports. Both adapters read their provider the
// same way, so the reading lives here, beside the refusal it reads.

import type {
  ModelAccountStatus,
  ModelAccountUsage,
  ModelUsageWindow,
} from "../../domain/model-account.js";
import type { ProviderAvailability } from "../../domain/provider-availability.js";
import { USAGE_LIMIT_FALLBACK_MS, type UsageRefusal } from "./refused-turn.js";

function windowExhausted(window: ModelUsageWindow | undefined): window is ModelUsageWindow {
  return (
    window?.remainingPercent === 0 ||
    (typeof window?.usedPercent === "number" && window.usedPercent >= 100)
  );
}

/** Usage was read and no window is exhausted: the provider has capacity again. */
export function usageShowsCapacity(usage: ModelAccountUsage): boolean {
  const windows = [usage.fiveHour, usage.sevenDay].filter((w) => w !== undefined);
  return !usage.error && windows.length > 0 && !windows.some(windowExhausted);
}

/** The latest reset among the windows, or undefined when one has none. */
function latestReset(windows: ModelUsageWindow[]): string | undefined {
  let latest: number | undefined;
  for (const window of windows) {
    const resetMs = Date.parse(window.resetsAt ?? "");
    if (Number.isNaN(resetMs)) return undefined;
    latest = Math.max(latest ?? resetMs, resetMs);
  }
  return latest === undefined ? undefined : new Date(latest).toISOString();
}

function ahead(until: string | undefined, now: number): string | undefined {
  return until !== undefined && Date.parse(until) > now ? until : undefined;
}

/**
 * The refusal as the account should keep holding it after it reported
 * `availability`: ending when the exhausted window resets, when that comes
 * first, so a usage read that fails later cannot bring the limit back past a
 * reset the provider stated.
 */
export function refusalAfterReport(
  refusal: UsageRefusal | undefined,
  availability: ProviderAvailability,
): UsageRefusal | undefined {
  const until = availability.usageLimitUntil;
  if (!refusal || !until || Date.parse(until) >= Date.parse(refusal.until)) return refusal;
  return { ...refusal, until };
}

/**
 * The availability read at `now` off the account's status, its usage (null
 * or an error when it could not be read) and the usage refusal it holds. The
 * exhausted windows say when a limit ends better than a refusal's assumed end
 * does: a weekly window outlasts it, a five-hour window may reset before it.
 * A window without a reset time is assumed to end the fallback after the
 * usage was checked, so reading the same usage again never moves the end.
 * Usage that could not be read (null, or an error) proves neither capacity
 * nor a limit, so a limit still ahead carries over from `previous`, the
 * account's last report.
 */
export function accountAvailability(
  status: ModelAccountStatus,
  usage: ModelAccountUsage | null,
  refusal: UsageRefusal | undefined,
  now: number,
  previous?: ProviderAvailability,
): ProviderAvailability {
  const base: ProviderAvailability = { state: "available", account: status };
  if (usage) base.usage = usage;
  if (status.needsReauth) return { ...base, state: "expired" };
  if (!status.loggedIn) return { ...base, state: "unauthorized" };
  if (status.usageLimited === false) return base;

  const limit = (until: string): ProviderAvailability => ({
    ...base,
    state: "usage_limit_reached",
    usageLimitUntil: until,
  });
  if (!usage || usage.error) {
    const carried = ahead(refusal?.until, now) ?? ahead(previous?.usageLimitUntil, now);
    return carried ? limit(carried) : base;
  }
  const exhausted = [usage.fiveHour, usage.sevenDay].filter(windowExhausted);
  if (exhausted.length > 0) {
    const checkedAt = Date.parse(usage.checkedAt);
    const seenAt = Number.isNaN(checkedAt) ? now : checkedAt;
    const fallback = new Date(seenAt + USAGE_LIMIT_FALLBACK_MS).toISOString();
    const windowEnd = ahead(latestReset(exhausted) ?? fallback, now);
    if (windowEnd) return limit(windowEnd);
  }
  const refusedUntil = ahead(refusal?.until, now);
  return refusedUntil ? limit(refusedUntil) : base;
}
