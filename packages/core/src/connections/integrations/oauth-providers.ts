// Rome Cloud-brokered OAuth provider connection state.
//
// Each provider is brokered by Rome Cloud OAuth: the guardian delegates access by
// clicking Connect, Rome Cloud runs the provider authorization, and the instance
// redeems a handoff for an OAuthTokenBundle. Conferral is route-driven
// (`romeCloudOAuth` — see schemes.ts), and renew() is "re-confer" until a
// Rome Cloud refresh exchange exists.
//
// The grant ledger is the system of record for whether a provider is connected.
// The tmpfs token files, GitHub shell auth, and `connector_proxy` remain custody
// consumers of that grant. GitHub and Google declare no capability here. Slack
// extends its base descriptor with Talk in `slack.ts`.
//
// Grant names follow the grant table: grants are about conferrals, not
// token count. GitHub and Google each mint one user credential → one `user`
// grant. Slack's single OAuth dance mints TWO tokens (bot + user) that live
// together in ONE `workspace` grant's material.

import { z } from "zod";
import {
  clearGithubShellIntegrationForProvider,
  syncGithubShellIntegrationForProvider,
} from "../../lib/github-shell-integration.js";
import type { OAuthProvider } from "../../lib/oauth-providers.js";
import { clearProviderTokenFile, syncProviderTokenFile } from "../../lib/provider-token-files.js";
import { romeCloudOAuth } from "../schemes.js";
import type { SetupContext, SetupFn, SetupInteraction, SetupView } from "../setup/types.js";
import type {
  ConnectionDescriptor,
  Credential,
  GrantCustody,
  GrantName,
  ProfileDisplay,
  ProfileRecord,
} from "../types.js";

// Per-service grant-profile schemas. Rome Cloud's redeem hands over a RAW JSON
// object; each service parses that raw object against its own schema, and the
// parse OUTPUT is exactly what lands on the grant row as the opaque
// ProfileRecord. There is no shared normalization DTO in the service path.
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

/** Slack's grant profile: the installer's identity plus workspace identity. */
export const slackGrantProfileSchema = z
  .object({
    /** `<teamId>:<installerUserId>` — stable per installer-in-workspace. */
    subject: identityField,
    /** Workspace name — Rome Cloud surfaces it as the account label. */
    login: identityField,
    displayName: identityField,
    email: identityField,
    avatarUrl: identityField,
    scopes: scopesField,
    /** Slack workspace id — identity, never credential material; the token-file
     *  custody writes it beside the secret tokens. */
    teamId: identityField,
    /** Slack workspace name and bot identity captured from `auth.test`. */
    workspaceName: identityField,
    botUserId: identityField,
    botUsername: identityField,
    /** Slack application id captured from OAuth and checked on inbound events. */
    appId: identityField,
    /** The one-time Slack DM setup step completed. The actual guardian identity
     *  lives only in the person mapping written by SetupManager. */
    guardianLinked: z.literal(true).optional(),
  })
  .strict();
export type SlackGrantProfile = z.infer<typeof slackGrantProfileSchema>;

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

export const OAUTH_PROVIDER_PROFILE_SCHEMAS = {
  github: githubGrantProfileSchema,
  slack: slackGrantProfileSchema,
  google: googleGrantProfileSchema,
} as const;

/** Any service-owned OAuth grant profile, for OAuth-layer code that fans out
 *  per provider (e.g. the token-file serializer). */
export type OAuthProviderGrantProfile = GithubGrantProfile | SlackGrantProfile | GoogleGrantProfile;

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
  slack: "workspace",
};

// Pure display mappings: parsed service profile (plain data) in, frozen display
// object out. The returned object is what satisfies the readonly
// `ProfileDisplay` interface — there are no profile classes. Service-specific
// values a generic reader can't render (subject, scopes, Slack's teamId) stay
// on the parsed profile for owner-side readers and never reach the display.

export function toGithubDisplay(profile: GithubGrantProfile): ProfileDisplay {
  return Object.freeze({
    displayName: profile.displayName,
    handle: profile.login,
    email: profile.email,
    avatarUrl: profile.avatarUrl,
  });
}

export function toSlackDisplay(profile: SlackGrantProfile): ProfileDisplay {
  return Object.freeze({
    /** A connected Slack card names the workspace and identifies the Rome bot. */
    displayName: profile.workspaceName ?? profile.displayName,
    handle: profile.botUsername ? `@${profile.botUsername}` : profile.login,
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

/** Each service revives a stored record by re-running its OWN parse, then
 *  mapping the parsed plain data through its pure display function. A record
 *  that no longer matches the schema throws instead of displaying sparsely. */
const OAUTH_PROVIDER_REVIVERS: Record<OAuthProvider, (record: ProfileRecord) => ProfileDisplay> = {
  github: (record) => toGithubDisplay(githubGrantProfileSchema.parse(record)),
  slack: (record) => toSlackDisplay(slackGrantProfileSchema.parse(record)),
  google: (record) => toGoogleDisplay(googleGrantProfileSchema.parse(record)),
};

/**
 * Custody for a Rome Cloud-OAuth provider: the tmpfs token file (github/slack) and
 * the `gh`/git shell auth (github only). The registry fires this off grant
 * transitions, so the artifacts are a pure function of grant state — present and
 * current iff the grant is authorized. The shell auth runs first (it swallows its
 * own subprocess errors) so a token-file write error can't skip it; the token
 * file may throw and the registry's fire-and-forget wrapper swallows it.
 */
function makeOAuthProviderCustody(provider: OAuthProvider): GrantCustody {
  return {
    async sync(_grant, material, profile) {
      await syncGithubShellIntegrationForProvider(provider, material);
      await syncProviderTokenFile(provider, material, parseOAuthProviderProfile(provider, profile));
    },
    async clear() {
      await clearGithubShellIntegrationForProvider(provider);
      await clearProviderTokenFile(provider);
    },
  };
}

/** Human-facing provider labels for the setup's success view. */
const OAUTH_PROVIDER_LABELS: Record<OAuthProvider, string> = {
  github: "GitHub",
  slack: "Slack",
  google: "Google",
};

/**
 * The db-bound halves of the Rome Cloud-OAuth setup, injected from the wire stage
 * (index.ts) so the descriptor module stays free of the DB handle and the
 * transitional `provider_accounts` mappers.
 */
export interface OAuthProviderSetupDeps {
  /** Mint the PKCE attempt and return the broker authorize URL the guardian is
   *  handed off to. Its `state` query param is the return-leg correlation. */
  beginRedirect: () => Promise<string>;
  /** Redeem the return-leg handoff into a proven credential + parsed grant
   *  profile. Throws when the bundle carries no usable credential (fail-closed:
   *  the setup fails and nothing is written). */
  redeem: (
    handoff: string,
    state: string,
  ) => Promise<{ credential: Credential; profile?: ProfileRecord }>;
}

/** Shared Rome Cloud OAuth redirect/validation/redeem stage. Integrations may
 * supply their own progress copy, then continue with service-specific proof. */
export async function redeemOAuthRedirect(
  interact: SetupInteraction,
  ctx: SetupContext,
  deps: OAuthProviderSetupDeps,
  progress: SetupView,
): Promise<{ credential: Credential; profile?: ProfileRecord }> {
  const url = await deps.beginRedirect();
  const returned = await interact.redirect(url);
  if (typeof returned.error === "string" && returned.error) {
    throw new Error(
      returned.error === "access_denied"
        ? "Authorization was declined."
        : `Authorization failed: ${returned.error}`,
    );
  }
  const handoff = typeof returned.handoff === "string" ? returned.handoff.trim() : "";
  const state = typeof returned.state === "string" ? returned.state.trim() : "";
  if (!handoff || !state) throw new Error("The authorization return was incomplete.");

  interact.show(progress);
  return ctx.step("oauth-redeem", () => deps.redeem(handoff, state));
}

/**
 * The conferral setup for a Rome Cloud-brokered OAuth provider. A linear
 * coroutine of the `redirect` mechanic:
 *   1. `beginRedirect` mints the PKCE attempt + authorize URL,
 *   2. `interact.redirect(url)` hands the guardian off to the broker and
 *      suspends until the return leg (the browser navigates fully away and back;
 *      the setup route resumes this coroutine, correlated by the `state` param),
 *   3. `ctx.step` redeems the handoff into a credential + profile (cancellable),
 *   4. return the terminal conferral — the single durable write of credential +
 *      profile lands only once the redeem proves the grant, via the manager's
 *      `registry.confer` (which re-materializes the tmpfs token file + gh/git
 *      shell auth through custody). Abandoning at any point writes nothing.
 *
 * There is no guardian-channel mapping (OAuth providers are not channels), so
 * the conferral omits `guardianChannelUserId`.
 */
export function makeOAuthProviderSetup(
  provider: OAuthProvider,
  deps: OAuthProviderSetupDeps,
): SetupFn {
  return async (interact, ctx) => {
    const { credential, profile } = await redeemOAuthRedirect(interact, ctx, deps, {
      body: [`Finishing the connection to ${OAUTH_PROVIDER_LABELS[provider]}…`],
      progress: true,
    });

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
 * Build a provider's ConnectionDescriptor: one Rome Cloud-OAuth grant, no
 * capabilities, and grant-state-driven custody of its out-of-process artifacts
 * (the tmpfs token file + gh/git shell auth). The descriptor holds the provider's
 * connection/grant state (imported by the oauth redeem route and the boot
 * providerAccounts import); Actor/Watcher capabilities land in follow-ups.
 *
 * `setupDeps` attaches the conferral setup (the redirect cutover) to the
 * grant's scheme. Omitted in tests that exercise connection state only;
 * threaded from index.ts at boot so the setup can reach the DB.
 */
export function makeOAuthProviderDescriptor(
  provider: OAuthProvider,
  setupDeps?: OAuthProviderSetupDeps,
): ConnectionDescriptor {
  const scheme = romeCloudOAuth({ provider });
  if (setupDeps) scheme.setup = makeOAuthProviderSetup(provider, setupDeps);
  return {
    service: provider,
    auth: {
      [OAUTH_PROVIDER_GRANTS[provider]]: scheme,
    },
    reviveProfile: (_grant, record) => OAUTH_PROVIDER_REVIVERS[provider](record),
    custody: makeOAuthProviderCustody(provider),
    capabilities: {},
  };
}
