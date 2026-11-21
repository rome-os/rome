/**
 * vault_apply — Requests a time-limited grant for one or several vault
 * secrets. The guardian approves it with a PIN. Afterward
 * `vault load NAME[,NAME2] -- <command>` can run.
 */

/** Give exactly one of `names` and `name`. */
export interface VaultApplyInput {
  /** The names of the secrets, as listed by vault_search. One to 10, each once. */
  names?: string[];
  /** One secret's name. The same as `names` with one entry. */
  name?: string;
  /** Minutes the grant lasts, 1 to 180. Defaults to 15. */
  ttlMinutes?: number;
  /** Why the secrets are needed. Shown to the guardian on the approval card. */
  reason: string;
}

export interface VaultApplyOutput {
  /** The first of `names`. */
  name: string;
  names: string[];
  /** ISO-8601 end of the earliest grant. */
  expiresAt: string;
  message: string;
}
