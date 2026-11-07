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
 * How long a usage refusal holds against a usage read that shows capacity.
 * The provider's usage endpoints lag the turn they refused, and a limit can
 * lie outside the windows they report, so a read in the minutes after a
 * refusal describes the account before the refusal and cannot clear it. The
 * refresh after the hold, or the refusal's own end, does.
 */
export const USAGE_REFUSAL_HOLD_MS = 5 * 60_000;

/** A usage refusal the account holds: when the provider said it ends, and when the adapter saw it. */
export interface UsageRefusal {
  /** The provider's stated end, null when it said none. */
  until: string | null;
  refusedAt: number;
}

/** Whether a usage read at `readAt` that shows capacity clears `refusal`. */
export function usageReadClearsRefusal(refusal: UsageRefusal, readAt: number): boolean {
  return readAt - refusal.refusedAt >= USAGE_REFUSAL_HOLD_MS;
}
