// The `/api/ai-tools/rome-credits` wire contract, shared by the route that
// produces it, the dashboard that parses it, and the mock handlers.

/**
 * The account's Rome credits, as Rome Cloud's inference gateway reports them.
 * Amounts are US dollar microdollars (1,000,000 = US$1) as decimal strings, so
 * integer precision survives JSON. The balance is the account's, the same on
 * every instance signed in to it.
 */
export interface RomeCreditsView {
  /** Everything ever granted to the account. */
  grantedMicros: string;
  /** What is left. Can dip below zero after an overrun. */
  balanceMicros: string;
  /** What is left minus holds for requests still running. */
  availableMicros: string;
  /** False when an operator has disabled inference for the account. */
  enabled: boolean;
  /**
   * The Codex model names the gateway serves this account, matched exactly
   * against the model a request sends. Empty when inference is disabled.
   * Absent when the gateway does not report them, which means unknown.
   */
  models?: string[];
}

export interface RomeCreditsResponse {
  /** Null when this instance is not signed in to Rome Cloud or has no grant. */
  credits: RomeCreditsView | null;
}
