// The Claude account as Rome reads it: stored Anthropic-compatible
// credentials, else an environment credential, else the Claude CLI's own
// login. The guardian authorizes Claude outside Rome, with the Claude CLI, so
// this adapter implements ModelAccount and ClaudeLogins, and has no
// authorization to start.

import { execFile } from "node:child_process";
import type { SettingsRepository } from "../../../../db/repositories/settings.js";
import type { StoredAnthropicCompatibleCredentials } from "@rome/api-types/anthropic-compatible-providers";
import {
  ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING,
  getStoredAnthropicCompatibleCredentials,
  summarizeAnthropicCompatibleCredentials,
} from "../../../../lib/anthropic-compatible-providers.js";
import { getErrorMessage, readClaudeOAuthUsage } from "../../../../lib/provider-usage.js";
import { createLogger } from "../../../../logger.js";
import type {
  ModelAccount,
  ModelAccountStatus,
  ModelAccountUsage,
} from "../../../domain/model-account.js";
import type { ClaudeLogins } from "../../../domain/model-login.js";
import type { ModelAccountReport } from "../../../domain/model-account-report.js";
import { accountReport, refusalAfterReport, usageShowsCapacity } from "../account-report.js";
import {
  type LearnsRefusedTurns,
  type RefusedTurn,
  type UsageRefusal,
  usageReadClearsRefusal,
  usageRefusalAt,
  usageRefusalEnded,
} from "../refused-turn.js";
import { claudeLoginFrom } from "./login.js";
import {
  clearClaudeAuthRevoked,
  clearStoredAnthropicCompatibleAuthRevoked,
  isAnthropicAuthRevoked,
  isAnthropicCompatibleAuthRevoked,
} from "./refused-credential.js";

const log = createLogger("claude-account");

/** The auth methods the provider bills per use, so their usage has no limit. */
const UNLIMITED_AUTH_METHODS = new Set(["stored-compatible", "environment"]);

export interface ClaudeAccountOptions {
  settingsRepo?: Pick<SettingsRepository, "get" | "set" | "delete">;
  env?: NodeJS.ProcessEnv;
  readCliStatus?: () => Promise<ModelAccountStatus>;
  /** Whether the provider refused the CLI's credential, from the persisted marker. */
  readCredentialRevoked?: () => Promise<boolean>;
  readUsage?: () => Promise<ModelAccountUsage | null>;
  logout?: () => Promise<void>;
  now?: () => number;
}

/**
 * Runs the Claude CLI. `claude auth status` exits non-zero when signed out
 * and still prints the status, so a status read keeps the output on a failed
 * exit; any other command fails with the exit.
 */
function runClaude(args: string[], tolerate: "exit-with-output" | "nothing"): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("claude", args, { timeout: 10_000 }, (err, stdout) => {
      if (err && (tolerate === "nothing" || !stdout.trim())) {
        reject(new Error(getErrorMessage(err)));
        return;
      }
      resolve(stdout);
    });
  });
}

async function readClaudeCliStatus(): Promise<ModelAccountStatus> {
  const output = (await runClaude(["auth", "status"], "exit-with-output")).trim();
  if (!output) throw new Error("claude auth status printed nothing");
  let parsed: ModelAccountStatus & { subscriptionType?: unknown; apiProvider?: unknown };
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Failed to parse claude auth status output");
  }
  const needsReauth = parsed.loggedIn ? await isAnthropicAuthRevoked() : false;
  return {
    ...parsed,
    loggedIn: needsReauth ? false : parsed.loggedIn,
    needsReauth: needsReauth || undefined,
    accountType:
      typeof parsed.subscriptionType === "string"
        ? parsed.subscriptionType
        : typeof parsed.apiProvider === "string"
          ? parsed.apiProvider
          : parsed.accountType,
  };
}

async function logoutClaude(): Promise<void> {
  await runClaude(["auth", "logout"], "nothing");
  await clearClaudeAuthRevoked();
}

export class ClaudeAccount implements ModelAccount, ClaudeLogins, LearnsRefusedTurns {
  private readonly options: ClaudeAccountOptions;
  private readonly listeners = new Set<() => void>();
  /** The usage refusal the adapter last saw, until its end or a later usage read shows capacity. */
  private refusal: UsageRefusal | undefined;
  /** The last report, so a limit still ahead survives a usage read that fails. */
  private last: ModelAccountReport | undefined;

  constructor(options: ClaudeAccountOptions = {}) {
    this.options = options;
  }

  /**
   * Reads the status and the usage together. A usage read that shows
   * capacity after the hold ends a refusal; one in the hold describes the
   * account before the refused turn.
   */
  async report(): Promise<ModelAccountReport> {
    const readAt = this.now();
    const [status, usage] = await Promise.all([this.status(), this.usage()]);
    if (usage && usageShowsCapacity(usage) && this.refusal) {
      if (usageReadClearsRefusal(this.refusal, readAt)) this.refusal = undefined;
    }
    this.last = accountReport(status, usage, this.heldRefusal(), this.now(), this.last);
    this.refusal = refusalAfterReport(this.refusal, this.last);
    return this.last;
  }

  async status(): Promise<ModelAccountStatus> {
    const base = await this.readStatus().catch(async (err: unknown) => {
      // The provider refused the credential and the CLI cannot say so right
      // now: the persisted marker still does, and a run must not keep
      // selecting an account the provider refused.
      if (await (this.options.readCredentialRevoked ?? isAnthropicAuthRevoked)()) {
        return { ...this.last?.account, loggedIn: false, needsReauth: true };
      }
      // Likewise a usage refusal the account holds: the account it last read
      // still stands for it, so the refusal is reported rather than lost.
      if (this.heldRefusal() && this.last) return this.last.account;
      throw err;
    });
    return { ...base, usageLimited: !UNLIMITED_AUTH_METHODS.has(base.authMethod ?? "") };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The refusal still held: one whose end has not passed. */
  private heldRefusal(): UsageRefusal | undefined {
    if (this.refusal && usageRefusalEnded(this.refusal, this.now())) this.refusal = undefined;
    return this.refusal;
  }

  /** Stored Anthropic-compatible credentials or an environment credential: the provider bills per use. */
  private async billedPerUse(): Promise<boolean> {
    const stored = await getStoredAnthropicCompatibleCredentials(this.options.settingsRepo);
    return claudeLoginFrom(stored, this.options.env ?? process.env).kind === "api_credential";
  }

  private async readStatus(): Promise<ModelAccountStatus> {
    const env = this.options.env ?? process.env;
    const credentials = await getStoredAnthropicCompatibleCredentials(this.options.settingsRepo);
    const login = claudeLoginFrom(credentials, env);
    if (login.kind === "subscription") {
      return await (this.options.readCliStatus ?? readClaudeCliStatus)();
    }
    if (credentials) {
      const summary = summarizeAnthropicCompatibleCredentials(credentials);
      const revoked = await isAnthropicCompatibleAuthRevoked(this.options.settingsRepo);
      return {
        loggedIn: !revoked,
        authMethod: "stored-compatible",
        accountType: summary?.providerName,
        needsReauth: revoked || undefined,
      };
    }
    return { loggedIn: true, authMethod: "environment", accountType: "API key" };
  }

  /** The usage, or an error read, or null for an account with no usage windows. */
  async usage(): Promise<ModelAccountUsage | null> {
    // An account billed per use has no usage windows. The OAuth endpoint
    // would answer for a subscription login that may still be on disk, which
    // is not this account's usage.
    if (await this.billedPerUse()) return null;
    // Claude keeps no local usage files, so the OAuth endpoint is the one source.
    try {
      return await (this.options.readUsage ?? readClaudeOAuthUsage)();
    } catch (err) {
      return {
        checkedAt: new Date(this.now()).toISOString(),
        source: "claude oauth usage",
        error: getErrorMessage(err),
      };
    }
  }

  async revoke(): Promise<void> {
    await (this.options.logout ?? logoutClaude)();
    this.refusal = undefined;
    this.emitChanged();
  }

  async storedCredential(): ReturnType<ClaudeLogins["storedCredential"]> {
    const { settingsRepo } = this.options;
    const [credential, expired] = await Promise.all([
      getStoredAnthropicCompatibleCredentials(settingsRepo),
      isAnthropicCompatibleAuthRevoked(settingsRepo),
    ]);
    return credential ? { credential, expired } : null;
  }

  async storeCredential(credential: StoredAnthropicCompatibleCredentials): Promise<void> {
    await this.settings().set(ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING, credential);
    await clearStoredAnthropicCompatibleAuthRevoked();
    this.emitChanged();
  }

  async removeCredential(): Promise<void> {
    await this.settings().delete(ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING);
    await clearStoredAnthropicCompatibleAuthRevoked();
    this.emitChanged();
  }

  private settings(): NonNullable<ClaudeAccountOptions["settingsRepo"]> {
    if (!this.options.settingsRepo) throw new Error("Claude account has no settings");
    return this.options.settingsRepo;
  }

  refusedTurn(refusal: RefusedTurn): void {
    if (refusal.kind === "usage") {
      this.refusal = usageRefusalAt(refusal, this.now());
    }
    this.emitChanged();
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
  }

  private emitChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        log.warn("Claude account change listener failed", { error: getErrorMessage(err) });
      }
    }
  }
}
