// Which login Codex runs on: Rome's setup decides it, from the guardian's
// logins, the instance credential and the account's Rome credits.
// The agent context runs on what this picks (CodexLogins) and does not know
// why. docs/concepts/rome-cloud.md states the rule.

import type { RomeCreditsView } from "@rome/api-types/rome-credits";
import {
  type AgentLog,
  type CodexLoginChoice,
  type CodexLogins,
  type ModelAccountReport,
  type ModelAccounts,
} from "../agent/index.js";
import { instanceCredentialId, onInstanceTokenChanged } from "../instance/instance-identity.js";
import { getRomeCloudOrigin } from "../instance/rome-cloud-origin.js";
import { fetchRomeCredits } from "../agent/index.js";

/** Credits are used only while the account can spend them. */
function canSpend(view: RomeCreditsView | null): boolean {
  return view !== null && view.enabled && BigInt(view.availableMicros) > 0n;
}

/**
 * The login Codex should run on. Rome credits are used only while the guardian
 * is logged in to no AI account: no ChatGPT login and no Claude login. A login
 * that expired or was revoked still counts, so a lost sign-in or a usage limit
 * never brings them in: the chat shows a card instead.
 * Credits need a linked instance and credits that can be spent. Otherwise the
 * answer is `subscription`, and availability says whether it can run.
 * This login only makes credits reachable: an ask spends them only when the
 * guardian made them the default or moved its chat onto them (resolveModel).
 */
export function codexLoginFor(input: {
  openai: ModelAccountReport | undefined;
  /** Claude has a login, perhaps expired, or Rome has not read it yet. */
  claudeSignedIn: boolean;
  credentialId: string | null;
  credits: RomeCreditsView | null;
}): CodexLoginChoice {
  const { openai, credentialId, credits } = input;
  if (!credentialId || !canSpend(credits)) return { kind: "subscription" };
  if (openai?.state !== "unauthorized" || input.claudeSignedIn) return { kind: "subscription" };
  return { kind: "rome_credits", credentialId };
}

export interface CodexLoginChoiceHandle {
  stop(): void;
  /** The last read found credits this instance can spend. False before a read. */
  creditsUsable(): boolean;
  /**
   * Whether the instance is linked and its account has credits enabled,
   * spendable or used up. Undefined until the first read settles while linked.
   */
  creditsEnabled(): boolean | undefined;
  /** The last read of the account's credits, or null before one or when not linked. */
  credits(): RomeCreditsView | null;
  /** Called when a read changes whether credits can be spent. */
  onCreditsChanged(listener: () => void): () => void;
  /** Decides the login again. */
  resync(): void;
}

/**
 * Keeps Codex on the right login until stopped. On a linked instance it reads
 * the credits when the credential changes and after each read of the ChatGPT
 * account, one read at a time, and decides again when an authorization or the
 * default changes. A failed read keeps the login.
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
}): CodexLoginChoiceHandle {
  const { accounts, logins, log } = options;
  const getCredentialId = options.getCredentialId ?? instanceCredentialId;
  const hasRomeCloud = options.hasRomeCloud ?? (() => getRomeCloudOrigin() !== null);
  const fetchCredits = options.fetchRomeCredits ?? (() => fetchRomeCredits());
  const onCredentialChanged = options.onCredentialChanged ?? onInstanceTokenChanged;
  let credentialId = getCredentialId();
  let stopped = false;
  // Whether a credential could spend credits, as of the last sync. Reads
  // happen only while it holds.
  let linked = false;
  // The last credits read, while linked, and whether one has settled.
  let credits: RomeCreditsView | null = null;
  let creditsRead = false;
  let inFlight: object | null = null;
  const creditListeners = new Set<() => void>();

  const choose = (): void => {
    const reports = accounts.read();
    const claude = reports.anthropic;
    logins.useLogin(
      codexLoginFor({
        openai: reports.openai,
        claudeSignedIn: claude === undefined || claude.state !== "unauthorized",
        credentialId: linked ? credentialId : null,
        credits,
      }),
    );
  };

  const setCredits = (next: RomeCreditsView | null, read = true): void => {
    const was = [canSpend(credits), creditsRead && credits?.enabled === true];
    credits = next;
    creditsRead = read;
    const now = [canSpend(next), read && next?.enabled === true];
    if (was[0] !== now[0] || was[1] !== now[1]) {
      for (const listener of creditListeners) listener();
    }
  };

  const readCredits = async (): Promise<void> => {
    if (stopped || !linked || inFlight) return;
    const read = {};
    inFlight = read;
    try {
      const view = await fetchCredits();
      // A sync since this read began changed what it would describe.
      if (inFlight !== read || stopped) return;
      setCredits(view);
      choose();
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
    const wasLinked = linked;
    linked = Boolean(next) && hasRomeCloud();
    // Another credential can belong to another account, so a read still in
    // flight does not describe it.
    if (credentialChanged || !linked) inFlight = null;
    if (!linked) {
      setCredits(null, true);
      logins.useLogin({ kind: "subscription" });
      return;
    }
    // The new credential takes over at once, and its read decides whether it stays.
    if (credentialChanged && next && logins.login().kind === "rome_credits") {
      logins.useLogin({ kind: "rome_credits", credentialId: next });
    }
    choose();
    if (credentialChanged || !wasLinked) void readCredits();
  };

  const stopCredential = onCredentialChanged(sync);
  // An authorization decides the login again, and each settled read of the
  // ChatGPT account re-reads the credits.
  const stopAccounts = accounts.onChanged((provider, change) => {
    if (change === "authorization") sync();
    else if (provider === "openai") void readCredits();
  });
  sync();

  return {
    stop() {
      stopped = true;
      inFlight = null;
      stopCredential();
      stopAccounts();
      creditListeners.clear();
    },
    creditsUsable: () => linked && canSpend(credits),
    creditsEnabled: () => {
      if (!linked) return false;
      return creditsRead ? credits?.enabled === true : undefined;
    },
    credits: () => (linked ? credits : null),
    onCreditsChanged(listener) {
      creditListeners.add(listener);
      return () => creditListeners.delete(listener);
    },
    resync: () => {
      if (!stopped && linked) choose();
    },
  };
}
