// Provider OAuth bundle-to-grant imports, shared by live writes and boot reconciliation.
//
// TRANSITIONAL MODULE. The whole `provider_accounts` bridge — this reconciler,
// the shared bundle→(material, profile) mappers, and the table itself — is
// deleted together once the grant ledger is the sole OAuth store.
//
// Two callers turn a provider's OAuth bundle into a grant with identical shape:
// the `/oauth/redeem` route (live conferral, via `importProviderBundle`) and the
// boot reconciler (`reconcileProviderAccounts`, rehydrating a pre-registry row).
// The bundle→(material, profile) mappers (`credentialFromBundle` /
// `grantProfileFromBundle`) live in exactly one place so the material and
// profile shapes are identical regardless of which path filled them.
//
// Boot reconcile (`reconcileProviderAccounts`): a `providerAccounts` table row
// predates the registry and the grant ledger — a legacy artifact on an instance
// that connected before the ledger was the OAuth store. The reconciler folds each
// such row into the grant ledger so connection state is live at boot WITHOUT the
// guardian re-connecting — the
// providerAccounts analogue of `importChannelSettings` (which reads the settings
// table). NOT gated on the connect-UI provider list (`getEnabledOAuthProviders`):
// a row that exists gets reconciled regardless; a missing row is a no-op anyway.
//
// It runs BEFORE `registry.load()` and writes the ledger tables directly (the
// registry isn't loaded yet), so rehydration sees every provider grant already
// at its FINAL state (authorized + credential + profile) and re-materializes
// custody exactly once, with complete material and profile — no half-imported
// grant is ever observable. Per row it applies whichever shape fits, the union
// of "import a fresh credential" and "backfill a missing profile":
//   - Grant absent or `unauthorized` → full import: credential + profile +
//     conferral timestamp, state `authorized`.
//   - Grant `authorized` with no profile → fill the profile only; the credential
//     is untouched (backfill for instances connected before profiles existed,
//     which a pure ledger-wins skip would strand without identity).
//   - Grant `degraded` → fill the profile only if absent; NEVER touch the
//     credential. Importing the same still-bad token would flip degraded →
//     authorized only to re-degrade; degrade-until-reconnect stays intact.
//   - A non-null profile is never overwritten: the ledger's own conferrals are
//     always newer than the legacy row, so a revoked-then-reconnected grant
//     keeps its fresh profile.
// Missing/empty row ⇒ no-op, never a revoke: a genuine disconnect deletes the
// row (getProviderTokenBundle returns null), so nothing resurrects.

import type { DrizzleDb } from "../db/index.js";
import { OAUTH_PROVIDERS, type OAuthProvider } from "../lib/oauth-providers.js";
import {
  getProviderAccountProfile,
  getProviderTokenBundle,
  normalizeScopes,
  type OAuthTokenBundle,
} from "../lib/provider-accounts.js";
import type { GrantLedger } from "./ledger.js";
import {
  OAUTH_PROVIDER_GRANTS,
  githubGrantProfileSchema,
  googleGrantProfileSchema,
  slackGrantProfileSchema,
  type OAuthProviderGrantProfile,
} from "./integrations/oauth-providers.js";
import { toPersisted } from "./registry.js";
import type { ConnectionRegistry } from "./registry.js";
import type { Credential, GrantName, SecretRecord } from "./types.js";

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

/**
 * Full import: authorize the grant with the bundle's credential + profile and a
 * fresh conferral timestamp. Written straight to the ledger (the reconciler runs
 * before the registry loads), mirroring `applyNewCredential`'s single update. A
 * sparse profile (no identity captured) is omitted rather than written as `{}`.
 */
async function authorizeGrantFromBundle(
  ledger: GrantLedger,
  custody: string,
  grant: GrantName,
  credential: Credential,
  profile: OAuthProviderGrantProfile,
): Promise<void> {
  await ledger.ensureGrant(custody, grant);
  await ledger.updateGrant(custody, grant, {
    state: "authorized",
    credential: toPersisted(credential),
    ...(hasProfile(profile) ? { profile } : {}),
    conferredAt: new Date(),
    degraded: undefined,
  });
}

function hasProfile(profile: OAuthProviderGrantProfile): boolean {
  return Object.keys(profile).length > 0;
}

/**
 * Boot-time PRE-LOAD reconciler: fold the legacy `provider_accounts` rows into
 * the grant ledger BEFORE `registry.load()`, so rehydration re-materializes each
 * provider grant once at its final state (authorized + credential + profile).
 * See the module header for the per-row shapes and why one pass is required.
 *
 * Reads the ledger tables directly through `ledger` (the registry isn't loaded
 * yet). `isRegistered` gates on the descriptor set so a provider with no
 * descriptor (a test wiring a subset) is skipped rather than minting an orphan
 * connection `load()` would only warn-and-drop.
 */
export async function reconcileProviderAccounts(
  ledger: GrantLedger,
  db: DrizzleDb,
  isRegistered: (service: string) => boolean,
): Promise<void> {
  const connections = await ledger.listConnections();
  for (const provider of OAUTH_PROVIDERS) {
    if (!isRegistered(provider)) continue;

    const bundle = await getProviderTokenBundle(db, provider);
    if (!bundle) continue;
    const credential = credentialFromBundle(provider, bundle);
    if (!credential) continue;

    const account = (await getProviderAccountProfile(db, provider)) ?? {};
    const profile = grantProfileFromBundle(provider, bundle, account);
    const grant = OAUTH_PROVIDER_GRANTS[provider];
    const existing = connections.find((c) => c.service === provider);

    // Fresh instance: a legacy row but no ledger connection yet. Mint the
    // connection row directly, then `ensureGrant` + authorize its single grant. Each
    // OAuth provider descriptor declares exactly one grant (OAUTH_PROVIDER_GRANTS),
    // so ensuring that one is the whole grant set — `load()` then rehydrates a
    // complete connection with no separate import step.
    if (!existing) {
      const id = crypto.randomUUID();
      await ledger.createConnection({
        id,
        service: provider,
        label: provider,
        createdAt: new Date(),
      });
      await authorizeGrantFromBundle(ledger, id, grant, credential, profile);
      continue;
    }

    const current = await ledger.getGrant(existing.id, grant);
    const state = current?.state ?? "unauthorized";

    // Absent or unauthorized (never conferred, or revoked): full import.
    if (state === "unauthorized") {
      await authorizeGrantFromBundle(ledger, existing.id, grant, credential, profile);
      continue;
    }

    // Authorized or degraded: the ledger's credential wins — never replace an
    // authorized token, never resurrect a degraded one. Only backfill a MISSING
    // profile; a non-null profile is a newer conferral and is never clobbered.
    if (current?.profile == null && hasProfile(profile)) {
      await ledger.updateGrant(existing.id, grant, { profile });
    }
  }
}
