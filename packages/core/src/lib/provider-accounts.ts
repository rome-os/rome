import { eq } from "drizzle-orm";
import { providerAccounts } from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import type { OAuthProvider } from "./oauth-providers.js";

export interface OAuthTokenBundle {
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  tokenType?: string | null;
  scope?: string[] | null;
  expiresAt?: string | null;
  raw?: Record<string, unknown> | null;
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

export async function removeProviderAccount(db: DrizzleDb, provider: OAuthProvider): Promise<void> {
  await db.delete(providerAccounts).where(eq(providerAccounts.provider, provider));
}
