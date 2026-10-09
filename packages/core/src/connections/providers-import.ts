// Provider OAuth bundle-to-grant imports for the `/oauth/redeem` route.
//
// The bundle→(material, profile) mappers (`credentialFromBundle` /
// `grantProfileFromBundle`) turn a provider's OAuth bundle into the grant's
// material and profile shapes.

import type { OAuthProvider } from "../lib/oauth-providers.js";
import { normalizeScopes, type OAuthTokenBundle } from "../lib/provider-accounts.js";
import {
  OAUTH_PROVIDER_GRANTS,
  githubGrantProfileSchema,
  googleGrantProfileSchema,
  slackGrantProfileSchema,
  type OAuthProviderGrantProfile,
} from "./integrations/oauth-providers.js";
import type { ConnectionRegistry } from "./registry.js";
import type { Credential, SecretRecord } from "./types.js";

/**
 * Flatten a provider's `OAuthTokenBundle` into its grant's `Credential`, or
 * `null` when the bundle carries no usable token (nothing to import — the
 * caller treats it as a no-op).
 *
 * Material shape per provider (flat `SecretRecord`, mirroring the grant table):
 * - `github` / `google`: `{ accessToken, refreshToken?, expiresAt? }`.
 * - `slack`: `{ botToken, userToken? }` — Slack v2 issues a bot token (`xoxb-`,
 *   the bundle's `accessToken`) plus a user token (`xoxp-`) that rides in `raw`
 *   (the verbatim oauth.v2.access response), same extraction the token-file
 *   serializer does. One OAuth dance, two tokens, ONE grant.
 *
 * Expiry: the credential's `expiresAt` mirrors the bundle's. GitHub and Slack
 * tokens are non-expiring, so an absent expiry becomes `"never"` and the
 * credential never reaches `renew()`. Google tokens DO expire — the expiry
 * flows through, and since no Rome Cloud refresh exchange exists yet
 * (`romeCloudOAuth.renew()` answers "re-confer"; a refresh-capable scheme is
 * territory), an expired google grant honestly degrades at load until
 * the guardian reconnects. That is intended.
 */
export function credentialFromBundle(
  provider: OAuthProvider,
  bundle: OAuthTokenBundle,
): Credential | null {
  const accessToken = bundle.accessToken?.trim();
  if (!accessToken) return null;

  let material: SecretRecord;
  if (provider === "slack") {
    const raw = (bundle.raw ?? {}) as { authed_user?: { access_token?: unknown } };
    material = { botToken: accessToken };
    if (typeof raw.authed_user?.access_token === "string") {
      material.userToken = raw.authed_user.access_token;
    }
  } else {
    material = { accessToken };
    if (bundle.refreshToken) material.refreshToken = bundle.refreshToken;
    if (bundle.expiresAt) material.expiresAt = bundle.expiresAt;
  }

  return {
    material,
    expiresAt: bundle.expiresAt ? new Date(bundle.expiresAt) : "never",
  };
}

/**
 * Pick a service's keys out of Rome Cloud's raw profile JSON. Mechanical only:
 * null / undefined / "" become ABSENT (the sparse case), while every other
 * value is passed through untouched so the service schema — not this picker —
 * decides validity. A wrong-typed value must FAIL the parse, never silently
 * drop.
 */
function pickRawKeys(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (value === null || value === undefined || value === "") continue;
    picked[key] = value;
  }
  return picked;
}

const IDENTITY_KEYS = ["subject", "displayName", "email", "avatarUrl"] as const;

/**
 * The profile half of the per-service parser: Rome Cloud's redeem hands over a
 * RAW JSON object (`account`), and each service parses it against its OWN
 * schema — the parse output is exactly what lands on the grant row. Scopes come
 * from `bundle`, Slack's `teamId` from `bundle.raw.team.id`. This is the
 * non-secret conferral outcome — deliberately NOT the opaque
 * handoff `metadata` bag, which is dropped here and never reaches the ledger.
 *
 * Fail-closed: a raw value the service schema rejects throws (ZodError) and
 * fails the conferral BEFORE anything is persisted — a partial or unparsed
 * profile is never stored.
 *
 * `teamId` is classified as PROFILE (which workspace the grant belongs to), not
 * material — the credential's material carries only the secret tokens.
 */
export function grantProfileFromBundle(
  provider: OAuthProvider,
  bundle: OAuthTokenBundle,
  account: unknown,
): OAuthProviderGrantProfile {
  const scopes = normalizeScopes(bundle.scope);
  const withScopes = (candidate: Record<string, unknown>): Record<string, unknown> => {
    if (scopes.length > 0) candidate.scopes = scopes;
    return candidate;
  };
  switch (provider) {
    case "google":
      // Google's schema has no login key — a raw handle never lands.
      return googleGrantProfileSchema.parse(withScopes(pickRawKeys(account, IDENTITY_KEYS)));
    case "github":
      return githubGrantProfileSchema.parse(
        withScopes(pickRawKeys(account, [...IDENTITY_KEYS, "login"])),
      );
    case "slack": {
      const candidate = withScopes(pickRawKeys(account, [...IDENTITY_KEYS, "login"]));
      const raw = (bundle.raw ?? {}) as { team?: { id?: unknown } };
      // Pass a present-but-wrong-typed team id through so the parse rejects it.
      if (raw.team?.id != null && raw.team.id !== "") candidate.teamId = raw.team.id;
      return slackGrantProfileSchema.parse(candidate);
    }
  }
}

/**
 * Make sure a provider's connection exists and import the bundle into its grant.
 * Mints the connection on first import (fresh install / first redeem after
 * upgrade); subsequent imports reuse the existing connection —
 * `importCredential`'s material comparison makes an unchanged re-import a no-op.
 *
 * A no-op (returns `false`) when the bundle has no usable token, or when the
 * registry doesn't declare the provider's descriptor (a test wiring a subset of
 * services). Returns `true` when a credential was imported.
 *
 * `account` is the redeem side's non-secret identity as a RAW JSON object.
 * When supplied (live conferral), the service parses it against its own schema
 * and the grant records the parsed profile (identity + scopes + Slack `teamId`)
 * in the SAME write as the credential — a parse rejection throws before
 * anything is persisted. When omitted, no profile is written.
 */
export async function importProviderBundle(
  registry: ConnectionRegistry,
  provider: OAuthProvider,
  bundle: OAuthTokenBundle,
  account?: unknown,
): Promise<boolean> {
  if (!registry.isRegistered(provider)) return false;
  const credential = credentialFromBundle(provider, bundle);
  if (!credential) return false;

  const existing = registry.find(provider)[0];
  const conn = existing ?? (await registry.connect(provider));
  const profile =
    account !== undefined ? grantProfileFromBundle(provider, bundle, account) : undefined;
  await registry.importCredential(conn.id, OAUTH_PROVIDER_GRANTS[provider], credential, profile);
  return true;
}
