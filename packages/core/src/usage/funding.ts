import { ROME_CREDITS_MODEL_PROVIDER_ID } from "../core/codex/rome-credits-provider.js";
import type { UsageFunding } from "./events.js";

/**
 * Funding for a Claude query. Stored Anthropic-compatible credentials and an
 * `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` are the guardian's own keys.
 * Without either, the Claude CLI runs on its subscription login.
 */
export function anthropicFunding(params: {
  hasCompatibleCredentials: boolean;
  env: Record<string, string | undefined>;
}): UsageFunding {
  if (params.hasCompatibleCredentials) return "byok";
  if (params.env.ANTHROPIC_API_KEY || params.env.ANTHROPIC_AUTH_TOKEN) return "byok";
  return "subscription";
}

/**
 * Funding for a Codex turn. The app-server's default provider decides first:
 * `rome_credits` bills the account's Rome credits. Otherwise the cached Codex
 * account type decides, and an account not yet probed is `unknown`.
 */
export function codexFunding(params: {
  defaultProvider: string | null;
  accountType: string | undefined;
  loggedIn: boolean | undefined;
}): UsageFunding {
  if (params.defaultProvider === ROME_CREDITS_MODEL_PROVIDER_ID) return "rome_credits";
  if (params.accountType === "api_key") return "byok";
  if (params.loggedIn && params.accountType) return "subscription";
  return "unknown";
}
