// The model provider login: how Rome is let in to a provider. The account
// (model-account.ts) is who, the login is how. Rome holds at most one login
// per provider at a time, and who is billed follows from it. Rome's setup
// picks the login Codex runs on; this context runs on what it is told.
// docs/domains/agents.md carries the language.

import type {
  ModelAuthorizationState,
  ModelBrowserAuthorization,
  ModelDeviceAuthorization,
} from "./model-account.js";

/** How Rome reaches Codex. `subscription` is the guardian's own: a ChatGPT login or an API credential. */
export type CodexLogin =
  | { kind: "subscription" }
  | {
      kind: "rome_credits";
      credentialId: string;
      /** What this login allows: the models the gateway serves, or null when it has not said. */
      modelsServed: readonly string[] | null;
    };

/** What setup chooses. The provider adds what the login allows. */
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
