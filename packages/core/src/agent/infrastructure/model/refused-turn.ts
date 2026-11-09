// A turn the provider refused, as the provider adapter sees it. The adapter
// tells its own account, and the account reports it from then on. Nothing
// outside the adapters' folder carries it.

export type RefusedTurn =
  /** The provider no longer accepts the credential. The adapter has persisted its marker. */
  | { kind: "credential" }
  /** The provider refused the turn for usage, until `until` when it said so. */
  | { kind: "usage"; until?: string };

export interface LearnsRefusedTurns {
  refusedTurn(refusal: RefusedTurn): void;
}

/**
 * A usage limit with no known end ends this long after it was seen, unless a
 * read or a refusal confirms it again. Waiting for a usage read that shows
 * capacity can wait forever: the Claude CLI renews its token only on a Claude
 * turn, and the resolver sends none to a provider at its limit.
 */
export const USAGE_LIMIT_FALLBACK_MS = 5 * 60 * 60 * 1000;

/**
 * How long a usage refusal holds against a usage read that shows capacity.
 * The provider's usage endpoints lag the turn they refused, and a limit can
 * lie outside the windows they report, so a read in the minutes after a
 * refusal describes the account before the refusal and cannot clear it. The
 * refresh after the hold, or the refusal's own end, does.
 */
export const USAGE_REFUSAL_HOLD_MS = 5 * 60_000;

/** A usage refusal the account holds: when it ends, and when the adapter saw it. */
export interface UsageRefusal {
  /** The provider's stated end, else the fallback after the refusal. */
  until: string;
  refusedAt: number;
}

/** The refusal an account holds for a usage refusal the adapter saw at `refusedAt`. */
export function usageRefusalAt(refusal: { until?: string }, refusedAt: number): UsageRefusal {
  const stated = Date.parse(refusal.until ?? "");
  const until =
    Number.isNaN(stated) || stated <= refusedAt
      ? new Date(refusedAt + USAGE_LIMIT_FALLBACK_MS).toISOString()
      : refusal.until!;
  return { until, refusedAt };
}

/** Whether the refusal's end has passed at `now`. */
export function usageRefusalEnded(refusal: UsageRefusal, now: number): boolean {
  return Date.parse(refusal.until) <= now;
}

/**
 * Whether a usage read that began at `readAt` and shows capacity clears
 * `refusal`. A read that began before the refusal, or within the hold after
 * it, describes the account before the refused turn.
 */
export function usageReadClearsRefusal(refusal: UsageRefusal, readAt: number): boolean {
  return readAt - refusal.refusedAt >= USAGE_REFUSAL_HOLD_MS;
}
