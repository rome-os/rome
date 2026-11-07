import type { ModelFunding } from "../../../domain/model-port.js";

/**
 * Funding for a Claude query. Stored Anthropic-compatible credentials and an
 * `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` are the guardian's own keys.
 * Without either, the Claude CLI runs on its subscription login.
 */
export function anthropicFunding(params: {
  hasCompatibleCredentials: boolean;
  env: Record<string, string | undefined>;
}): ModelFunding {
  if (params.hasCompatibleCredentials) return "byok";
  if (params.env.ANTHROPIC_API_KEY || params.env.ANTHROPIC_AUTH_TOKEN) return "byok";
  return "subscription";
}
