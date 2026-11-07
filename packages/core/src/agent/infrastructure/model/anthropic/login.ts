import type { StoredAnthropicCompatibleCredentials } from "@rome/api-types/anthropic-compatible-providers";
import { claudeLogin, type ClaudeLogin } from "../../../domain/model-login.js";

/** The login Claude runs on, given what is stored and the environment. */
export function claudeLoginFrom(
  stored: StoredAnthropicCompatibleCredentials | null,
  env: Record<string, string | undefined>,
): ClaudeLogin {
  return claudeLogin({
    stored: stored !== null,
    environment: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
  });
}
