// Which login Codex runs on: Rome's setup decides it, from the ChatGPT
// account's report, the instance credential and the account's Rome credits.
// The agent context runs on what this picks (CodexLogins) and does not know
// why. docs/concepts/rome-cloud.md states the rule.

import type { RomeCreditsView } from "@rome/api-types/rome-credits";
import {
  providerAuthorized,
  type AgentLog,
  type CodexLoginChoice,
  type CodexLogins,
  type ModelAccountReport,
  type ModelAccounts,
} from "../agent/index.js";
import { instanceCredentialId, onInstanceTokenChanged } from "../lib/instance-identity.js";
import { getRomeCloudOrigin } from "../lib/rome-cloud-origin.js";
import { fetchRomeCredits } from "../agent/index.js";

/** Credits are used only while the account can spend them. */
function canSpend(view: RomeCreditsView | null): boolean {
  return view !== null && view.enabled && BigInt(view.availableMicros) > 0n;
}

/**
 * The login Codex should run on. The guardian's ChatGPT login wins: Rome
 * credits are used only while the account is unauthorized or expired, the
 * instance is linked, and the credits can be spent. Without a login that can
 * run, the answer is `subscription`, and availability says it cannot.
 */
export function codexLoginFor(input: {
  openai: ModelAccountReport | undefined;
  credentialId: string | null;
  credits: RomeCreditsView | null;
}): CodexLoginChoice {
  const { openai, credentialId, credits } = input;
  if (providerAuthorized(openai) || !credentialId || !canSpend(credits)) {
    return { kind: "subscription" };
  }
  return { kind: "rome_credits", credentialId };
}

/**
 * Keeps Codex on the right login until the returned stop is called. It reads
 * the credits when ChatGPT disconnects, when the credential changes, and after
 * each read of the account, one read at a time. A failed read keeps the login.
 */
export function startCodexLoginChoice(options: {
  accounts: Pick<ModelAccounts, "read" | "onChanged">;
  logins: Pick<CodexLogins, "login" | "useLogin">;
  log?: AgentLog;
  /** The instance credential's stable id, or null when not linked. */
  getCredentialId?: () => string | null;
  hasRomeCloud?: () => boolean;
  fetchRomeCredits?: () => Promise<RomeCreditsView | null>;
  onCredentialChanged?: (listener: () => void) => () => void;
}): () => void {
  const { accounts, logins, log } = options;
  const getCredentialId = options.getCredentialId ?? instanceCredentialId;
  const hasRomeCloud = options.hasRomeCloud ?? (() => getRomeCloudOrigin() !== null);
  const fetchCredits = options.fetchRomeCredits ?? (() => fetchRomeCredits());
  const onCredentialChanged = options.onCredentialChanged ?? onInstanceTokenChanged;
  let credentialId = getCredentialId();
  let stopped = false;
  // Whether ChatGPT is out and a credential could spend credits, as of the
  // last sync. Reads happen only while it holds.
  let eligible = false;
  let inFlight: object | null = null;

  const readCredits = async (): Promise<void> => {
    if (stopped || !eligible || inFlight) return;
    const read = {};
    inFlight = read;
    try {
      const credits = await fetchCredits();
      // A sync since this read began changed what it would describe.
      if (inFlight !== read || stopped) return;
      logins.useLogin(codexLoginFor({ openai: accounts.read().openai, credentialId, credits }));
    } catch (err) {
      log?.warn("Rome credits unavailable", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (inFlight === read) inFlight = null;
    }
  };

  const sync = (): void => {
    if (stopped) return;
    const next = getCredentialId();
    const credentialChanged = next !== credentialId;
    credentialId = next;
    const wasEligible = eligible;
    eligible = !providerAuthorized(accounts.read().openai) && Boolean(next) && hasRomeCloud();
    // Another credential can belong to another account, so a read still in
    // flight does not describe it.
    if (credentialChanged || !eligible) inFlight = null;
    if (!eligible) {
      logins.useLogin({ kind: "subscription" });
      return;
    }
    // The new credential takes over at once, and its read decides whether it stays.
    if (credentialChanged && next && logins.login().kind === "rome_credits") {
      logins.useLogin({ kind: "rome_credits", credentialId: next });
    }
    if (credentialChanged || !wasEligible) void readCredits();
  };

  const stopCredential = onCredentialChanged(sync);
  // The Codex authorization drives the choice, and each settled read of the
  // account re-reads the credits.
  const stopAccounts = accounts.onChanged((provider, change) => {
    if (provider !== "openai") return;
    if (change === "authorization") sync();
    else void readCredits();
  });
  sync();

  return () => {
    stopped = true;
    inFlight = null;
    stopCredential();
    stopAccounts();
  };
}
