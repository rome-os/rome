// The Claude account as Rome reads it: stored Anthropic-compatible
// credentials, else an environment credential, else the Claude CLI's own
// login. The guardian authorizes Claude outside Rome, with the Claude CLI, so
// this adapter implements ModelAccount and not ModelAccountAuthorization.

import { execFile } from "node:child_process";
import type { SettingsRepository } from "../../../../db/repositories/settings.js";
import {
  getStoredAnthropicCompatibleCredentials,
  summarizeAnthropicCompatibleCredentials,
} from "../../../../lib/anthropic-compatible-providers.js";
import {
  clearClaudeAuthRevoked,
  isAnthropicAuthRevoked,
  isAnthropicCompatibleAuthRevoked,
} from "../../../../lib/anthropic-login.js";
import { getErrorMessage, readClaudeOAuthUsage } from "../../../../lib/provider-usage.js";
import { createLogger } from "../../../../logger.js";
import type {
  ModelAccount,
  ModelAccountStatus,
  ModelAccountUsage,
} from "../../../domain/model-account.js";
import { usageShowsCapacity } from "../../../domain/provider-availability.js";
import type { LearnsRefusedTurns, RefusedTurn } from "../refused-turn.js";

const log = createLogger("claude-account");

/** The auth methods the provider bills per use, so their usage has no limit. */
const UNLIMITED_AUTH_METHODS = new Set(["stored-compatible", "environment"]);

export interface ClaudeAccountOptions {
  settingsRepo?: Pick<SettingsRepository, "get">;
  env?: NodeJS.ProcessEnv;
  readCliStatus?: () => Promise<ModelAccountStatus>;
  readUsage?: () => Promise<ModelAccountUsage | null>;
  logout?: () => Promise<void>;
}

function runClaude(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("claude", args, { timeout: 10_000 }, (err, stdout) => {
      if (err && !stdout.trim()) {
        reject(new Error(getErrorMessage(err)));
        return;
      }
      resolve(stdout);
    });
  });
}

async function readClaudeCliStatus(): Promise<ModelAccountStatus> {
  const output = (await runClaude(["auth", "status"])).trim();
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
  await runClaude(["auth", "logout"]);
  await clearClaudeAuthRevoked();
}

export class ClaudeAccount implements ModelAccount, LearnsRefusedTurns {
  private readonly options: ClaudeAccountOptions;
  private readonly listeners = new Set<() => void>();
  /** The provider's stated end of a refused turn, null for none stated, undefined when not refused. */
  private usageLimitUntil: string | null | undefined;

  constructor(options: ClaudeAccountOptions = {}) {
    this.options = options;
  }

  async status(): Promise<ModelAccountStatus> {
    const base = await this.readStatus();
    const usageLimited = !UNLIMITED_AUTH_METHODS.has(base.authMethod ?? "");
    return {
      ...base,
      usageLimited,
      ...(usageLimited && this.usageLimitUntil !== undefined
        ? { usageLimitUntil: this.usageLimitUntil }
        : {}),
    };
  }

  private async readStatus(): Promise<ModelAccountStatus> {
    const env = this.options.env ?? process.env;
    const credentials = await getStoredAnthropicCompatibleCredentials(this.options.settingsRepo);
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
    if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
      return { loggedIn: true, authMethod: "environment", accountType: "API key" };
    }
    return await (this.options.readCliStatus ?? readClaudeCliStatus)();
  }

  async usage(): Promise<ModelAccountUsage | null> {
    // Claude keeps no local usage files, so the OAuth endpoint is the one source.
    const usage = await (this.options.readUsage ?? readClaudeOAuthUsage)();
    if (usage && usageShowsCapacity(usage)) this.usageLimitUntil = undefined;
    return usage;
  }

  async revoke(): Promise<void> {
    await (this.options.logout ?? logoutClaude)();
    this.usageLimitUntil = undefined;
    this.emitChanged();
  }

  refusedTurn(refusal: RefusedTurn): void {
    if (refusal.kind === "usage") this.usageLimitUntil = refusal.until ?? null;
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
