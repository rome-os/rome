// Connection authentication schemes. Vocabulary: docs/domains/connections.md.
// `credentialsPaste`
// (a guardian pastes one or more secret fields) is the general case; `tokenPaste`
// is its single-field `token` special case. `romeCloudOAuth` is the Rome Cloud-brokered
// OAuth scheme (GitHub/Slack); `qrPairing` comes in a later phase.

import type { AuthScheme, Credential, GuardianInteraction, SecretRecord } from "./types.js";

/** One field a guardian pastes. `secret` defaults to true (these are credentials);
 *  pass `secret: false` for a plain identifier like a domain. */
export interface CredentialsPasteField {
  /** The material key this field lands under (also the returned `material[name]`). */
  name: string;
  label: string;
  /** Default true. */
  secret?: boolean;
  format?: "line" | "multiline" | "file";
  /** Presented as a select when set. */
  options?: string[];
}

/**
 * A guardian pastes one or more fields (e.g. an app id + secret). The scheme
 * cannot renew without the guardian, so `renew` always answers "re-confer".
 *
 * `confer` prompts every field, runs `validate` (which throws when the pasted
 * material is not accepted), and returns a non-expiring credential whose
 * `material` is the collected `{ [field.name]: value }` record.
 */
export function credentialsPaste(opts: {
  fields: CredentialsPasteField[];
  instructions?: string;
  /** Throws when the pasted material is invalid (e.g. an auth ping fails). */
  validate: (material: SecretRecord) => Promise<void>;
}): AuthScheme {
  return {
    async confer(interact: GuardianInteraction): Promise<Credential> {
      const material = await interact.prompt({
        instructions: opts.instructions,
        fields: opts.fields.map((f) => ({
          name: f.name,
          label: f.label,
          secret: f.secret ?? true,
          format: f.format ?? "line",
          ...(f.options ? { options: f.options } : {}),
        })),
      });
      await opts.validate(material);
      return { material, expiresAt: "never" };
    },
    async renew(): Promise<Credential | "re-confer"> {
      return "re-confer";
    },
  };
}

/**
 * A guardian pastes a long-lived secret. The scheme cannot renew without the
 * guardian, so `renew` always answers "re-confer".
 *
 * `confer` prompts one secret field named "token", runs `validate` (which throws
 * on an invalid token), and returns a non-expiring `{ token }` credential. This
 * is `credentialsPaste` specialized to the single `token` field.
 */
export function tokenPaste(opts: {
  label: string;
  instructions?: string;
  /** Throws on an invalid token. */
  validate: (token: string) => Promise<void>;
}): AuthScheme {
  return credentialsPaste({
    instructions: opts.instructions,
    fields: [{ name: "token", label: opts.label, secret: true, format: "line" }],
    validate: (material) => opts.validate(material.token),
  });
}

/**
 * Rome Cloud-brokered OAuth. The guardian delegates access
 * by clicking Connect; Rome Cloud runs the provider authorization and returns a
 * single-use handoff the instance redeems for an `OAuthTokenBundle`. The bundle's
 * `accessToken` (and any `refreshToken`) lands in the grant material as a flat
 * record.
 *
 * Conferral is route-driven, exactly like WhatsApp pairing: the OAuth round-trip
 * runs in the browser + the `/oauth/{provider}/start` → `/oauth/redeem` routes,
 * which finish the flow with `importCredential`. There is no headless conferral
 * (guardian-interaction machinery is absent this phase), so `confer()`
 * throws — the route is the conferral driver.
 *
 * `renew()`: when the provider is wired with `refresh` and the credential carries
 * a refresh token, Rome Cloud runs the provider's refresh (it holds the client
 * secret) and the renewed credential replaces this one. Otherwise the bundle can
 * only be re-authorized by the guardian, and `renew()` answers "re-confer".
 * GitHub and Slack tokens don't expire, so a token whose `expiresAt` is `"never"`
 * never reaches `renew()` at all.
 */
export function romeCloudOAuth(opts: {
  provider: string;
  /** Exchange a refresh token for a renewed credential through Rome Cloud. */
  refresh?: (refreshToken: string) => Promise<Credential>;
}): AuthScheme {
  return {
    async confer(_interact: GuardianInteraction): Promise<Credential> {
      throw new Error(
        `conferral for "${opts.provider}" is driven by the oauth redeem route, not a headless confer()`,
      );
    },
    async renew(cred: Credential): Promise<Credential | "re-confer"> {
      const refreshToken =
        typeof cred.material === "function" ? undefined : cred.material.refreshToken;
      // Without a refresh path, a stale or refused bundle can only be replaced by
      // the guardian reconnecting.
      if (!opts.refresh || !refreshToken) return "re-confer";
      return opts.refresh(refreshToken);
    },
  };
}

/** The flat grant-material shape a `romeCloudOAuth` credential carries — the
 *  `OAuthTokenBundle`'s token fields as a `SecretRecord`. Optional keys are
 *  simply absent when the bundle didn't carry them. */
export interface RomeCloudOAuthMaterial extends SecretRecord {
  accessToken: string;
}
