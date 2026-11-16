// Vault — named secrets the guardian stores through Rome. Values live in the
// signer, never in the database, and never travel back: the API returns names
// and metadata only. Shared by core's routes, the dashboard, and mock mode.

/** The value-free wire shape of one stored secret. Timestamps are ISO-8601. */
export interface VaultSecretDto {
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** When the current grant ends. Absent while no grant is live. */
  grantedUntil?: string;
}

export interface VaultListResponse {
  secrets: VaultSecretDto[];
}

export const VAULT_MAX_VALUE_LENGTH = 32768;
export const VAULT_MAX_DESCRIPTION_LENGTH = 200;

/** A name is the environment variable `vault load` sets. The signer enforces the same pattern. */
export const VAULT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** Returns a human-readable rejection reason, or null when the name is usable. */
export function vaultNameError(name: string): string | null {
  if (name.length === 0) return "Name is required.";
  if (!VAULT_NAME_PATTERN.test(name)) {
    return "Name must be 1 to 64 characters: uppercase letters, digits and underscores, not starting with a digit.";
  }
  return null;
}
