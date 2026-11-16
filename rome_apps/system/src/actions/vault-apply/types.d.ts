/**
 * vault_apply — Requests a time-limited grant for one vault secret. The
 * guardian approves it. Afterward `vault load NAME -- <command>` can run.
 */

export interface VaultApplyInput {
  /** The secret's name, as listed by vault_search. */
  name: string;
  /** Minutes the grant lasts, 1 to 180. Defaults to 15. */
  ttlMinutes?: number;
  /** Why the secret is needed. Shown to the guardian on the approval card. */
  reason: string;
}

export interface VaultApplyOutput {
  name: string;
  /** ISO-8601 end of the grant. */
  expiresAt: string;
  message: string;
}
