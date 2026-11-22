// The default provider: the model provider every chat that follows the
// default runs on. The guardian picks it among the signed-in providers, and
// Rome credits count as one of their own. docs/domains/agents.md carries the
// language.

import { type AccountedProviderId, type ModelAccountReports } from "./model-account-report.js";

/** A provider the guardian can make the default. Rome credits run Codex. */
export type DefaultProvider = "anthropic" | "openai" | "rome_credits";

const DEFAULT_PROVIDERS: readonly DefaultProvider[] = ["anthropic", "openai", "rome_credits"];

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

/** A provider the guardian logged in to: a login that expired or was revoked still counts. */
function loggedIn(reports: ModelAccountReports, id: AccountedProviderId): boolean {
  return reports[id] !== undefined && reports[id].state !== "unauthorized";
}

/**
 * Signed in, as the default reads it: only a provider with no login is out.
 * One at its usage limit, or whose sign-in expired, is still signed in, so the
 * chat shows a card rather than the default moving. One Rome has not read yet
 * is not signed in. Rome credits count only while the guardian is logged in
 * to no AI account at all: any login hides them.
 */
export function signedInProviders(
  reports: ModelAccountReports,
  creditsEnabled: boolean,
): SignedInProviders {
  const anthropic = loggedIn(reports, "anthropic");
  const openai = loggedIn(reports, "openai");
  return { anthropic, openai, rome_credits: creditsEnabled && !anthropic && !openai };
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
 * The default after a login or a logout. With none yet, the first signed-in
 * provider becomes it. A default that is still signed in stays, whatever else
 * signs in, except Rome credits, which the first login replaces. A logged-out
 * default moves to the guardian's other login, an expired one included, and
 * with none left to Rome credits when `creditsUsable` says they take it: in
 * the guardian's logout, with credits enabled and a balance left, as the
 * logout dialog said. With neither it stays, so the next send shows why.
 * Usage limits and expired logins never move it.
 */
export function reconciledDefault(
  current: DefaultProvider | null,
  signedIn: SignedInProviders,
  first: DefaultProvider | null,
  creditsUsable = true,
): { provider: DefaultProvider | null; moved: boolean } {
  if (current === null) return { provider: first, moved: false };
  if (signedIn[current]) return { provider: current, moved: false };
  const remaining = (["anthropic", "openai"] as const).find(
    (candidate) => candidate !== current && signedIn[candidate],
  );
  if (remaining) {
    // Credits give way to the first login without a note: nothing was removed.
    return { provider: remaining, moved: current !== "rome_credits" };
  }
  if (current !== "rome_credits" && signedIn.rome_credits && creditsUsable) {
    return { provider: "rome_credits", moved: true };
  }
  return { provider: current, moved: false };
}

/**
 * Whether every chat runs on Rome credits: they are the default and no AI
 * account is logged in. Credits are the instance's choice, never one chat's.
 */
export function runsOnRomeCredits(
  current: DefaultProvider | null,
  signedIn: Pick<SignedInProviders, "anthropic" | "openai">,
): boolean {
  return current === "rome_credits" && !signedIn.anthropic && !signedIn.openai;
}
