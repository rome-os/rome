import { eq } from "drizzle-orm";
import { providerAccounts } from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import type { OAuthProvider } from "./oauth-providers.js";

// `tokenCiphertext` is a legacy column name; tokens travel as plain JSON, not
// ciphertext. Encryption is unnecessary here: the realistic threat (a guardian
// leaking their own SQLite file) is mitigated elsewhere, and Claude's own token
// cache (`~/.claude`) is unencrypted too, so a symmetric envelope would only add
// a required env var with no real benefit. The column name stays to avoid a
// migration.

/** The legacy `provider_accounts` row's identity columns (transitional bridge —
 *  this whole table dies with the ledger cutover). Raw input to the per-service
 *  profile parsers, never a stored profile shape itself. */
export interface LegacyOAuthAccountProfile {
  subject?: string | null;
  displayName?: string | null;
  email?: string | null;
  login?: string | null;
  avatarUrl?: string | null;
}

export interface OAuthTokenBundle {
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  tokenType?: string | null;
  scope?: string[] | null;
  expiresAt?: string | null;
  raw?: Record<string, unknown> | null;
}

function deserializeBundle<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    // A row still holding a legacy encrypted blob fails to parse as JSON; treat
    // it as "not connected" — the guardian reconnects and the row is rewritten
    // as plain JSON.
    return null;
  }
}

export function normalizeScopes(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === "string" && scope.length > 0);
  }

  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
  }

  return [];
}

async function getProviderAccountRow(db: DrizzleDb, provider: OAuthProvider) {
  const [row] = await db
    .select()
    .from(providerAccounts)
    .where(eq(providerAccounts.provider, provider))
    .limit(1);

  return row ?? null;
}

export async function getProviderTokenBundle(
  db: DrizzleDb,
  provider: OAuthProvider,
): Promise<OAuthTokenBundle | null> {
  const row = await getProviderAccountRow(db, provider);
  return row ? deserializeBundle<OAuthTokenBundle>(row.tokenCiphertext) : null;
}

/** The connected account's display identity (login / email / name / avatar),
 * captured at OAuth time. Consumers use it to attribute git commits to the real
 * user instead of a hardcoded identity, and the boot reconciler folds it into
 * the grant profile — so every persisted field must be returned or the migration
 * silently drops it. Returns null when the provider isn't linked. */
export async function getProviderAccountProfile(
  db: DrizzleDb,
  provider: OAuthProvider,
): Promise<LegacyOAuthAccountProfile | null> {
  const row = await getProviderAccountRow(db, provider);
  if (!row) return null;
  return {
    subject: row.providerAccountId ?? undefined,
    displayName: row.displayName ?? undefined,
    email: row.email ?? undefined,
    login: row.login ?? undefined,
    avatarUrl: row.avatarUrl ?? undefined,
  };
}

export async function removeProviderAccount(db: DrizzleDb, provider: OAuthProvider): Promise<void> {
  await db.delete(providerAccounts).where(eq(providerAccounts.provider, provider));
}
