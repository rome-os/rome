// The model provider login: how Rome is let in to a provider. The account
// (model-account.ts) is who, the login is how. Rome holds at most one login
// per provider at a time, and who is billed follows from it. Rome's setup
// picks the login Codex runs on; this context runs on what it is told.
// docs/domains/agents.md carries the language.

import type {
  AnthropicCompatibleCredentialsSummary,
  StoredAnthropicCompatibleCredentials,
} from "@rome/api-types/anthropic-compatible-providers";
import type {
  ModelAuthorizationState,
  ModelBrowserAuthorization,
  ModelDeviceAuthorization,
} from "./model-account.js";

/** How Rome reaches Codex. Before Rome has read the account, the guardian's own login reads as `subscription`. */
export type CodexLogin =
  | { kind: "subscription" }
  | { kind: "api_credential" }
  | {
      kind: "rome_credits";
      credentialId: string;
      /** What this login allows: the models the gateway serves, or null when it has not said. */
      modelsServed: readonly string[] | null;
    };

/** What setup chooses: the guardian's own login, or Rome credits. The provider adds what the login allows. */
export type CodexLoginChoice =
  | { kind: "subscription" }
  | { kind: "rome_credits"; credentialId: string };

/** Whether the two are the same login. A new credential on Rome credits is another login. */
export function sameCodexLogin(a: CodexLoginChoice, b: CodexLoginChoice): boolean {
  if (a.kind === "rome_credits" && b.kind === "rome_credits") {
    return a.credentialId === b.credentialId;
  }
  return a.kind === b.kind;
}

/** How Rome reaches Claude. `subscription` is the Claude CLI's own login. */
export type ClaudeLogin =
  | { kind: "subscription" }
  | { kind: "api_credential"; source: "stored" | "environment" };

/** A stored credential wins over an environment credential, which wins over the CLI's login. */
export function claudeLogin(facts: { stored: boolean; environment: boolean }): ClaudeLogin {
  if (facts.stored) return { kind: "api_credential", source: "stored" };
  if (facts.environment) return { kind: "api_credential", source: "environment" };
  return { kind: "subscription" };
}

/** Logging Rome out of a provider. Both adapters implement it. */
export interface ModelProviderLogins {
  /** Takes the guardian's login back. */
  revoke(): Promise<void>;
}

/** Everything that logs Rome in to Codex. */
export interface CodexLogins extends ModelProviderLogins {
  authorizationState(): ModelAuthorizationState;
  startBrowserAuthorization(): Promise<ModelBrowserAuthorization>;
  startDeviceAuthorization(): Promise<ModelDeviceAuthorization>;
  cancelAuthorization(): Promise<void>;
  /** The login Codex runs on now. */
  login(): CodexLogin;
  /**
   * Runs Codex on this login. Restarts Codex when the login changes, which
   * fails the turns running then. A new credential on Rome credits is a change.
   * Throws once closed, or when the login needs a Rome Cloud origin and the
   * instance has none.
   */
  useLogin(login: CodexLoginChoice): void;
}

/** The stored credential as the dashboard's editor shows it. `env` holds a custom credential's secret. */
export interface ClaudeStoredCredential extends AnthropicCompatibleCredentialsSummary {
  env?: Record<string, string>;
}

/** The credential Rome keeps for Claude, and logging out of the CLI. */
export interface ClaudeLogins extends ModelProviderLogins {
  /** Logs the Claude CLI out. A stored credential stays, and stays the login. */
  revoke(): Promise<void>;
  /** The stored credential and whether the provider refused it, or null when there is none. */
  storedCredential(): Promise<(ClaudeStoredCredential & { needsReauth: boolean }) | null>;
  /**
   * `credential` is already validated. Replaces what is stored, clears the
   * mark that the provider refused the stored credential, then tells the
   * account. Throws when Rome has no settings to write to.
   */
  storeCredential(
    credential: StoredAnthropicCompatibleCredentials,
  ): Promise<ClaudeStoredCredential>;
  /** Removes it and clears the same mark, then tells the account. A held usage refusal stays. */
  removeCredential(): Promise<void>;
}
