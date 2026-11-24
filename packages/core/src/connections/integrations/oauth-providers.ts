// Rome Cloud-brokered OAuth provider connection state.
//
// Each provider is brokered by Rome Cloud OAuth: the guardian delegates access by
// clicking Connect, Rome Cloud runs the provider authorization, and the instance
// redeems a handoff for an OAuthTokenBundle. Grant is route-driven
// (`romeCloudOAuth` — see schemes.ts). Google, Shopify and Microsoft renew
// through Cloud.
//
// Google and Microsoft keep mail credentials in Core-only Actors (Gmail,
// Outlook) so shell tools and apps cannot bypass send approval with a raw token. Other providers keep their
// token-file consumers. All providers share the registry's grant lifecycle.
//
// Grant names follow the grant table: grants are about grants, not
// token count. GitHub, Google and Microsoft each mint one user credential → one `user`
// grant. Shopify mints one offline token for a store, not a person → one
// `store` grant.

import { z } from "zod";
import { createGmailActor } from "../gmail/api.js";
import { createOutlookActor } from "../outlook/api.js";
import {
  clearGithubShellIntegrationForProvider,
  syncGithubShellIntegrationForProvider,
} from "./github-shell-integration.js";
import {
  normalizeShopifyShopDomain,
  OAUTH_PROVIDER_DESCRIPTORS,
  type OAuthProvider,
} from "../oauth/oauth-providers.js";
import { clearProviderTokenFile, syncProviderTokenFile } from "../oauth/provider-token-files.js";
import { romeCloudOAuth } from "../schemes.js";
import type { SetupFn } from "../setup/types.js";
import type {
  Actor,
  ConnectionDescriptor,
  Credential,
  GrantCustody,
  GrantName,
  ProfileDisplay,
  ProfileRecord,
} from "../types.js";

// Per-kind grant-profile schemas. Rome Cloud's redeem hands over a RAW JSON
// object; each connection kind parses that raw object against its own schema, and the
// parse OUTPUT is exactly what lands on the grant row as the opaque
// ProfileRecord. There is no shared normalization DTO on this path.
// The same schema re-runs on revive, so a stored record that no longer matches
// fails loudly instead of yielding a silently sparse display.

/** A present identity value: a non-empty string. Absent keys are the sparse
 *  case; null / "" never land (the redeem picker normalizes them to absent). */
const identityField = z.string().min(1).optional();
const scopesField = z.array(z.string().min(1)).optional();

/** GitHub's grant profile: the authorizing user's identity. `login` and `email`
 *  feed the git committer identity; the summary shows the rest. */
export const githubGrantProfileSchema = z
  .object({
    /** GitHub user id. */
    subject: identityField,
    login: identityField,
    displayName: identityField,
    email: identityField,
    avatarUrl: identityField,
    scopes: scopesField,
  })
  .strict();
export type GithubGrantProfile = z.infer<typeof githubGrantProfileSchema>;

/** Google's grant profile: OIDC identity. Google mints no handle — there is
 *  deliberately no `login` key in this schema. */
export const googleGrantProfileSchema = z
  .object({
    /** OIDC `sub`. */
    subject: identityField,
    displayName: identityField,
    email: identityField,
    avatarUrl: identityField,
    scopes: scopesField,
  })
  .strict();
export type GoogleGrantProfile = z.infer<typeof googleGrantProfileSchema>;

/** Shopify's grant profile: the connected store. A store has no handle of its
 *  own beyond its domain, so `login` is the `<store>.myshopify.com` domain. */
export const shopifyGrantProfileSchema = z
  .object({
    /** The store's `.myshopify.com` domain, which Shopify never changes. */
    subject: identityField,
    /** Also the `.myshopify.com` domain: the Admin API host, and the store's
     *  label in Settings. The token-file custody writes it beside the token. */
    login: identityField,
    /** The store's name. */
    displayName: identityField,
    /** The store owner's email. */
    email: identityField,
    scopes: scopesField,
  })
  .strict();
export type ShopifyGrantProfile = z.infer<typeof shopifyGrantProfileSchema>;

/** Microsoft's grant profile: OIDC identity from the ID token. Like Google,
 *  no handle; Microsoft serves no avatar URL. */
export const microsoftGrantProfileSchema = z
  .object({
    /** OIDC `sub`, pairwise to Rome's Microsoft app. */
    subject: identityField,
    displayName: identityField,
    email: identityField,
    scopes: scopesField,
  })
  .strict();
export type MicrosoftGrantProfile = z.infer<typeof microsoftGrantProfileSchema>;

export const OAUTH_PROVIDER_PROFILE_SCHEMAS = {
  github: githubGrantProfileSchema,
  google: googleGrantProfileSchema,
  shopify: shopifyGrantProfileSchema,
  microsoft: microsoftGrantProfileSchema,
} as const;

/** Any kind-specific OAuth grant profile, for OAuth-layer code that fans out
 *  per provider (e.g. the token-file serializer). */
export type OAuthProviderGrantProfile =
  | GithubGrantProfile
  | GoogleGrantProfile
  | ShopifyGrantProfile
  | MicrosoftGrantProfile;

/** Validate a record against `provider`'s own schema. Fail-closed: a value that
 *  doesn't match throws (ZodError) — callers never see a partial profile. */
export function parseOAuthProviderProfile(
  provider: OAuthProvider,
  record: unknown,
): OAuthProviderGrantProfile {
  return OAUTH_PROVIDER_PROFILE_SCHEMAS[provider].parse(record);
}

/** The single grant each Rome Cloud-OAuth provider's descriptor declares. */
export const OAUTH_PROVIDER_GRANTS: Record<OAuthProvider, GrantName> = {
  github: "user",
  google: "user",
  shopify: "store",
  microsoft: "user",
};

// Pure display mappings: parsed profile (plain data) in, frozen display
// object out. The returned object is what satisfies the readonly
// `ProfileDisplay` interface — there are no profile classes. Kind-specific
// values a generic reader can't render (subject, scopes) stay
// on the parsed profile for owner-side readers and never reach the display.

export function toGithubDisplay(profile: GithubGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: profile.displayName,
    handle: profile.login,
    email: profile.email,
    avatarUrl: profile.avatarUrl,
  });
}

export function toGoogleDisplay(profile: GoogleGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: profile.displayName,
    // Google mints no handle.
    handle: undefined,
    email: profile.email,
    avatarUrl: profile.avatarUrl,
  });
}

export function toShopifyDisplay(profile: ShopifyGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: profile.displayName,
    /** The `.myshopify.com` domain reads as Shopify's handle. */
    handle: profile.login,
    email: profile.email,
    // Shopify has no store avatar.
    avatarUrl: undefined,
  });
}

export function toMicrosoftDisplay(profile: MicrosoftGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: profile.displayName,
    handle: undefined,
    email: profile.email,
    avatarUrl: undefined,
  });
}

/** Each connection kind revives a stored record by re-running its OWN parse, then
 *  mapping the parsed plain data through its pure display function. A record
 *  that no longer matches the schema throws instead of displaying sparsely. */
const OAUTH_PROVIDER_REVIVERS: Record<OAuthProvider, (record: ProfileRecord) => ProfileDisplay> = {
  github: (record) => toGithubDisplay(githubGrantProfileSchema.parse(record)),
  google: (record) => toGoogleDisplay(googleGrantProfileSchema.parse(record)),
  shopify: (record) => toShopifyDisplay(shopifyGrantProfileSchema.parse(record)),
  microsoft: (record) => toMicrosoftDisplay(microsoftGrantProfileSchema.parse(record)),
};

/**
 * Custody for a Rome Cloud-OAuth provider: the tmpfs token file (github/shopify) and
 * the `gh`/git shell auth (github only). The registry fires this off grant
 * transitions, so the artifacts are a pure function of grant state — present and
 * current iff the grant is authorized. The shell auth runs first (it swallows its
 * own subprocess errors) so a token-file write error can't skip it; the token
 * file may throw and the registry's fire-and-forget wrapper swallows it.
 */
function makeOAuthProviderCustody(provider: OAuthProvider): GrantCustody {
  return {
    async sync(material, profile) {
      await syncGithubShellIntegrationForProvider(provider, material);
      await syncProviderTokenFile(provider, material, parseOAuthProviderProfile(provider, profile));
    },
    async clear() {
      await clearGithubShellIntegrationForProvider(provider);
      await clearProviderTokenFile(provider);
    },
  };
}

/** Providers whose grant only a Core-only mail Actor may use. */
const MAIL_ACTORS: Partial<Record<OAuthProvider, (credential: Credential) => Actor>> = {
  google: createGmailActor,
  microsoft: createOutlookActor,
};

/** Human-facing provider labels for the setup's success view. */
const OAUTH_PROVIDER_LABELS: Record<OAuthProvider, string> = {
  github: "GitHub",
  google: "Google",
  shopify: "Shopify",
  microsoft: "Microsoft",
};

/**
 * The db-bound halves of the Rome Cloud-OAuth setup, injected from the wire stage
 * (index.ts) so the descriptor module stays free of the DB handle.
 */
export interface OAuthProviderSetupDeps {
  /** Mint the PKCE attempt and return the broker authorize URL the guardian is
   *  handed off to. Its `state` query param is the return-leg correlation.
   *  `shop` names the store for Shopify, which authorizes per store. */
  beginRedirect: (opts?: { shop?: string }) => Promise<string>;
  /** Redeem the return-leg handoff into a proven credential + parsed grant
   *  profile. Throws when the bundle carries no usable credential (fail-closed:
   *  the setup fails and nothing is written). */
  redeem: (
    handoff: string,
    state: string,
  ) => Promise<{ credential: Credential; profile?: ProfileRecord }>;
  /** Exchange the grant's refresh token for a renewed credential through Rome
   *  Cloud. Lets an expiring grant (Shopify's hourly token) renew without the
   *  guardian; it throws when Rome Cloud can't refresh it. */
  refresh?: (refreshToken: string) => Promise<Credential>;
}

/** The form that asks which store to connect, for a guardian's own Shopify app. */
const SHOPIFY_STORE_FORM = {
  instructions:
    "Enter the store your own Shopify app connects to, like acme.myshopify.com, or paste the store's admin address.",
  fields: [{ name: "shop", label: "Store address", secret: false }],
  note: "Only for a Shopify app you saved in Rome Cloud. To connect Rome OS, use Connect in Shopify instead.",
} as const;

/**
 * Ask the guardian which Shopify store to connect, re-asking until the answer is
 * a `.myshopify.com` store. Shopify authorizes per store, so Rome Cloud needs the
 * store before it can send the guardian to Shopify's consent screen.
 *
 * Only a guardian's own Shopify app needs this. Rome OS connects through
 * `SHOPIFY_INSTALL_URL`, where Shopify asks which store, because Shopify's App
 * Store rules forbid a public app from asking the merchant to type it. An own
 * app has no install link Rome knows, and Rome Cloud picks the own app only when
 * the guardian saved one there, which this instance cannot see.
 */
async function promptShopifyStore(interact: Parameters<SetupFn>[0]): Promise<string> {
  let error: string | undefined;
  for (;;) {
    const answers = await interact.prompt({
      ...SHOPIFY_STORE_FORM,
      fields: [...SHOPIFY_STORE_FORM.fields],
      ...(error ? { error } : {}),
    });
    const shop = normalizeShopifyShopDomain(answers.shop);
    if (shop) return shop;
    error =
      "Enter a store address like acme.myshopify.com, or paste your admin address like admin.shopify.com/store/acme.";
  }
}

/**
 * The setup for a Rome Cloud-brokered OAuth provider. A linear
 * coroutine of the `redirect` mechanic:
 *   0. Shopify only: `promptShopifyStore` asks which store to connect,
 *   1. `beginRedirect` mints the PKCE attempt + authorize URL,
 *   2. `interact.redirect(url)` hands the guardian off to the broker and
 *      suspends until the return leg (the browser navigates fully away and back;
 *      the setup route resumes this coroutine, correlated by the `state` param),
 *   3. `ctx.step` redeems the handoff into a credential + profile (cancellable),
 *   4. return the terminal grant — the single durable write of credential +
 *      profile lands only once the redeem proves the grant, via the manager's
 *      `registry.giveGrant` (which re-materializes the tmpfs token file + gh/git
 *      shell auth through custody). Abandoning at any point writes nothing.
 *
 * OAuth providers are not channels, so the grant omits `connectedBy`.
 */
export function makeOAuthProviderSetup(
  provider: OAuthProvider,
  deps: OAuthProviderSetupDeps,
): SetupFn {
  return async (interact, ctx) => {
    const shop = provider === "shopify" ? await promptShopifyStore(interact) : undefined;
    const url = await deps.beginRedirect(shop ? { shop } : undefined);
    const returned = await interact.redirect(url);

    // A denied consent (or any broker-reported error) fails the setup cleanly —
    // the guardian sees the reason and can retry from a fresh authorize.
    if (typeof returned.error === "string" && returned.error) {
      throw new Error(
        returned.error === "access_denied"
          ? "Authorization was declined."
          : `Authorization failed: ${returned.error}`,
      );
    }
    const handoff = typeof returned.handoff === "string" ? returned.handoff.trim() : "";
    const state = typeof returned.state === "string" ? returned.state.trim() : "";
    if (!handoff || !state) {
      throw new Error("The authorization return was incomplete.");
    }

    interact.show({
      body: [`Finishing the connection to ${OAUTH_PROVIDER_LABELS[provider]}…`],
      progress: true,
    });
    const { credential, profile } = await ctx.step("oauth-redeem", () =>
      deps.redeem(handoff, state),
    );

    return {
      credential,
      profile,
      summary: {
        title: `${OAUTH_PROVIDER_LABELS[provider]} connected`,
        body: [`Your ${OAUTH_PROVIDER_LABELS[provider]} account is linked.`],
      },
    };
  };
}

/**
 * Build one Rome Cloud-OAuth grant. Google and Microsoft use Core-only mail
 * Actors; the other providers keep grant-state-driven token-file and shell custody.
 *
 * `setupDeps` attaches the setup (the redirect cutover) to the
 * grant's scheme. Omitted in tests that exercise connection state only;
 * threaded from index.ts at boot so the setup can reach the DB.
 */
export function makeOAuthProviderDescriptor(
  provider: OAuthProvider,
  setupDeps?: OAuthProviderSetupDeps,
): ConnectionDescriptor {
  const scheme = romeCloudOAuth({ provider, refresh: setupDeps?.refresh });
  if (setupDeps) scheme.setup = makeOAuthProviderSetup(provider, setupDeps);
  return {
    connectionKind: provider,
    label: OAUTH_PROVIDER_DESCRIPTORS[provider].label,
    grant: OAUTH_PROVIDER_GRANTS[provider],
    auth: scheme,
    reviveProfile: (record) => OAUTH_PROVIDER_REVIVERS[provider](record),
    // The provider's own id for the signed-in identity: the user, or for
    // Shopify the store.
    accountIdOf: (record) => (typeof record.subject === "string" && record.subject) || null,
    custody: makeOAuthProviderCustody(provider),
    capabilities: MAIL_ACTORS[provider] ? { actor: { build: MAIL_ACTORS[provider] } } : {},
  };
}
