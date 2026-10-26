// A connection's grant, as a value. Vocabulary: docs/domains/connections.md#grant.
//
// Invariants the store and tests hold:
//  1. Runtime never reads inside `material`, only the envelope (`expiresAt`, kind).
//  2. Rehydration needs code, never the guardian: a persisted credential and
//     its descriptor give a live capability at boot.
//  3. A grant records outcomes only: no step or flow state, no scheme-specific
//     fields.
//  4. A grant has no guardian-facing identity of its own. Giving a grant mints
//     a new epoch; renewal and kit.persist retain that epoch.

import type { GrantState, ProfileRecord, SecretRecord } from "./types.js";

/**
 * The persisted form of a `Credential`. Inline custody stores the secret record
 * verbatim; external custody (`{ kind: "external" }`) stores no secret — the
 * live material comes from the scheme's `resolveExternal` resolver at rehydration.
 */
export interface PersistedCredential {
  material: { kind: "inline"; record: SecretRecord } | { kind: "external" };
  expiresAt: Date | "never";
}

/** The account a grant reaches: its platform and the platform's own id for it,
 *  read from the grant's profile when access was given. */
export interface GrantAccount {
  platform: string;
  accountId: string;
}

export interface GrantRecord {
  custody: string; // connectionId
  state: GrantState;
  credential?: PersistedCredential; // present ⇔ state !== "unauthorized"
  /** The non-secret half of the grant outcome, written in the
   *  SAME update as `credential` — never through a separate setter. Absent until
   *  a grant supplies one; degrade preserves it (no wipe), revoke clears it. */
  profile?: ProfileRecord;
  /** The account the profile names, written in the same update as the profile
   *  and cleared with it. Absent when the profile names none. At most one grant
   *  in any state but "unauthorized" reaches an account. */
  account?: GrantAccount;
  /** When the last grant filled this grant. Retained through `revoke()`. */
  grantedAt?: Date;
  /** Opaque identity of the authority that filled this grant. App access
   *  policies bind to it so giving the grant again cannot inherit an older policy. */
  grantEpoch?: string;
  lastRenewedAt?: Date;
  degraded?: { at: Date; reason: string };
}

/** A connection's grant as one value: everything the ledger keeps for it. A
 *  grant has no identity of its own, so every write replaces it whole.
 *  Vocabulary: docs/domains/connections.md#grant. */
export type GrantValue = Omit<GrantRecord, "custody">;

/** What a connection holds when no grant fills it. */
export const NO_GRANT: GrantValue = { state: "unauthorized" };

/** The value of `record`, or NO_GRANT when there is none. */
export function grantValueOf(record: GrantRecord | null): GrantValue {
  if (!record) return NO_GRANT;
  const { custody: _custody, ...value } = record;
  return value;
}
