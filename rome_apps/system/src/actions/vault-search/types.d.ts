/**
 * vault_search — Lists vault secrets: metadata only, never values.
 */

export interface VaultSearchInput {
  /** Case-insensitive text matched against names and descriptions. Omit to list everything. */
  query?: string;
}

export interface VaultSearchSecret {
  name: string;
  description: string;
  lastUsedAt: string | null;
  /** ISO-8601 end of the live grant. Absent when no grant is live. */
  grantedUntil?: string;
}

export interface VaultSearchOutput {
  secrets: VaultSearchSecret[];
}
