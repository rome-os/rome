import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { CodexPlanType } from "./codex-cli-auth.js";
import {
  getStoredAnthropicCompatibleCredentials,
  summarizeAnthropicCompatibleCredentials,
} from "./anthropic-compatible-providers.js";
import type { AnthropicCompatibleCredentialsSummary } from "@rome/api-types/anthropic-compatible-providers";
import { isAnthropicAuthRevoked, isAnthropicCompatibleAuthRevoked } from "./anthropic-login.js";
import {
  type AIToolUsageStatus,
  getErrorMessage,
  readClaudeOAuthUsage,
  readLiveOrCachedUsage,
} from "./provider-usage.js";

export interface AIToolStatusProbeResult {
  loggedIn: boolean;
  authMode?: "chatgpt" | "apikey" | null;
  planType?: CodexPlanType;
  email?: string;
  authMethod?: string;
  accountType?: string;
  needsReauth?: boolean;
  anthropicCompatible?: (AnthropicCompatibleCredentialsSummary & { needsReauth?: boolean }) | null;
}

const CLAUDE_USAGE_CACHE_PATHS = ["usage-limits.json", "rate-limits.json"].map((file) =>
  join(homedir(), ".claude", file),
);

function readClaudeCliStatus(): Promise<AIToolStatusProbeResult> {
  return new Promise((resolve, reject) => {
    execFile("claude", ["auth", "status"], { timeout: 10_000 }, async (err, stdout) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(new Error(getErrorMessage(err)));
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as AIToolStatusProbeResult & {
          subscriptionType?: unknown;
          apiProvider?: unknown;
        };
        const needsReauth = parsed.loggedIn ? await isAnthropicAuthRevoked() : false;
        resolve({
          ...parsed,
          loggedIn: needsReauth ? false : parsed.loggedIn,
          needsReauth: needsReauth || undefined,
          accountType:
            typeof parsed.subscriptionType === "string"
              ? parsed.subscriptionType
              : typeof parsed.apiProvider === "string"
                ? parsed.apiProvider
                : parsed.accountType,
        });
      } catch {
        reject(new Error("Failed to parse claude auth status output"));
      }
    });
  });
}

export async function getClaudeStatus(
  settingsRepo?: Pick<SettingsRepository, "get">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AIToolStatusProbeResult> {
  const credentials = await getStoredAnthropicCompatibleCredentials(settingsRepo);
  if (credentials) {
    const summary = summarizeAnthropicCompatibleCredentials(credentials);
    const revoked = await isAnthropicCompatibleAuthRevoked(settingsRepo);
    return {
      loggedIn: !revoked,
      authMethod: "stored-compatible",
      accountType: summary?.providerName,
      needsReauth: revoked || undefined,
      anthropicCompatible: summary ? { ...summary, needsReauth: revoked || undefined } : null,
    };
  }
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
    return { loggedIn: true, authMethod: "environment", accountType: "API key" };
  }
  return await readClaudeCliStatus();
}

export async function readClaudeUsage(): Promise<AIToolUsageStatus | null> {
  return await readLiveOrCachedUsage(readClaudeOAuthUsage, CLAUDE_USAGE_CACHE_PATHS, {
    utilizationUnit: "percent",
  });
}
