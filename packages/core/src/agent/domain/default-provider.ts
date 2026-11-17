// The default provider: the model provider every chat that follows the
// default runs on. The guardian picks it among the signed-in providers, and
// Rome credits count as one of their own. docs/domains/agents.md carries the
// language.

import { type AccountedProviderId, type ModelAccountReports } from "./model-account-report.js";

/** A provider the guardian can make the default. Rome credits run Codex. */
export type DefaultProvider = "anthropic" | "openai" | "rome_credits";

export const DEFAULT_PROVIDERS: readonly DefaultProvider[] = [
  "anthropic",
  "openai",
  "rome_credits",
];

export function isDefaultProvider(value: unknown): value is DefaultProvider {
  return typeof value === "string" && (DEFAULT_PROVIDERS as readonly string[]).includes(value);
}

/** The model provider a default runs on. */
export function providerOfDefault(provider: DefaultProvider): AccountedProviderId {
  return provider === "anthropic" ? "anthropic" : "openai";
}

/** Rome moved the default because the guardian removed the one it was. */
export interface DefaultProviderNote {
  from: DefaultProvider;
  to: DefaultProvider;
  at: string;
}

export interface DefaultProviderState {
  /** Null until a provider has signed in. */
  provider: DefaultProvider | null;
  note?: DefaultProviderNote;
}

/** Port. Where the default provider is kept. */
export interface DefaultProviderSetting {
  /** A malformed value reads as none. */
  read(): Promise<DefaultProviderState>;
  write(state: DefaultProviderState): Promise<void>;
}

/** Which providers are signed in: the guardian's own logins, and spendable Rome credits. */
export interface SignedInProviders {
  anthropic: boolean;
  openai: boolean;
  rome_credits: boolean;
}

/**
 * Signed in, as the default reads it: only a provider with no login is out.
 * One at its usage limit, or whose sign-in expired, is still signed in, so the
 * chat shows a card rather than the default moving. One Rome has not read yet
 * is not signed in.
 */
export function signedInProviders(
  reports: ModelAccountReports,
  creditsSignedIn: boolean,
): SignedInProviders {
  const signedIn = (id: AccountedProviderId) =>
    reports[id] !== undefined && reports[id].state !== "unauthorized";
  return {
    anthropic: signedIn("anthropic"),
    openai: signedIn("openai"),
    rome_credits: creditsSignedIn,
  };
}

/**
 * The provider the hard-coded order picked before the default existed: Codex
 * on its subscription, Claude, Codex on ChatGPT credits, then Rome credits.
 * An upgrade starts from it, so nothing moves.
 */
export function legacyDefault(
  reports: ModelAccountReports,
  signedIn: SignedInProviders,
): DefaultProvider | null {
  if (signedIn.openai && !reports.openai?.requiresChatgptCredits) return "openai";
  if (signedIn.anthropic) return "anthropic";
  if (signedIn.openai) return "openai";
  if (signedIn.rome_credits) return "rome_credits";
  return null;
}

/**
 * The default after a sign-in or a removal. With none yet, the first signed-in
 * provider becomes it. A default that is still signed in stays, whatever else
 * signs in. A removed default moves to a remaining provider, the guardian's
 * own logins first, and with none left it stays, so the next send shows why.
 * Usage limits never move it.
 */
export function reconciledDefault(
  current: DefaultProvider | null,
  signedIn: SignedInProviders,
  first: DefaultProvider | null,
): { provider: DefaultProvider | null; moved: boolean } {
  if (current === null) return { provider: first, moved: false };
  if (signedIn[current]) return { provider: current, moved: false };
  const remaining = (["anthropic", "openai", "rome_credits"] as const).find(
    (candidate) => candidate !== current && signedIn[candidate],
  );
  return remaining ? { provider: remaining, moved: true } : { provider: current, moved: false };
}
