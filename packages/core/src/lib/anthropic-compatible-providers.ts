import type { SettingsRepository } from "../db/repositories/settings.js";
import { validateCustomAnthropicEnv } from "@rome/api-types/anthropic-compatible-env";
import {
  ANTHROPIC_COMPATIBLE_PROVIDERS,
  CUSTOM_ANTHROPIC_PROVIDER_ID,
  isAnthropicCompatibleProviderId,
  type AnthropicCompatibleCredentialsSummary,
  type StoredAnthropicCompatibleCredentials,
} from "@rome/api-types/anthropic-compatible-providers";

export const ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING = "aiTools.anthropicCompatibleCredentials";

export interface AnthropicCompatibleCredentialsEditorSummary
  extends AnthropicCompatibleCredentialsSummary {
  env?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseStoredAnthropicCompatibleCredentials(
  value: unknown,
): StoredAnthropicCompatibleCredentials | null {
  if (!isRecord(value) || typeof value.updatedAt !== "string") {
    return null;
  }

  if (value.provider === CUSTOM_ANTHROPIC_PROVIDER_ID) {
    const parsed = validateCustomAnthropicEnv(value.env);
    if (!parsed.ok) return null;
    return {
      provider: CUSTOM_ANTHROPIC_PROVIDER_ID,
      env: parsed.env,
      updatedAt: value.updatedAt,
    };
  }

  if (
    !isAnthropicCompatibleProviderId(value.provider) ||
    typeof value.apiKey !== "string" ||
    !value.apiKey.trim()
  ) {
    return null;
  }

  return {
    provider: value.provider,
    apiKey: value.apiKey,
    updatedAt: value.updatedAt,
  };
}

export function summarizeAnthropicCompatibleCredentials(
  credentials: StoredAnthropicCompatibleCredentials | null,
): AnthropicCompatibleCredentialsSummary | null {
  if (!credentials) return null;
  return {
    provider: credentials.provider,
    providerName:
      credentials.provider === CUSTOM_ANTHROPIC_PROVIDER_ID
        ? "Custom"
        : ANTHROPIC_COMPATIBLE_PROVIDERS[credentials.provider].name,
    hasApiKey: true,
    updatedAt: credentials.updatedAt,
  };
}

export function summarizeAnthropicCompatibleCredentialsForEditing(
  credentials: StoredAnthropicCompatibleCredentials | null,
): AnthropicCompatibleCredentialsEditorSummary | null {
  const summary = summarizeAnthropicCompatibleCredentials(credentials);
  if (!summary || !credentials || credentials.provider !== CUSTOM_ANTHROPIC_PROVIDER_ID) {
    return summary;
  }

  return { ...summary, env: { ...credentials.env } };
}

export async function getStoredAnthropicCompatibleCredentials(
  settingsRepo?: Pick<SettingsRepository, "get">,
): Promise<StoredAnthropicCompatibleCredentials | null> {
  if (!settingsRepo) return null;
  return parseStoredAnthropicCompatibleCredentials(
    await settingsRepo.get(ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING),
  );
}

export function buildAnthropicCompatibleProviderEnv(
  credentials: StoredAnthropicCompatibleCredentials,
): Record<string, string> {
  if (credentials.provider === CUSTOM_ANTHROPIC_PROVIDER_ID) {
    return { ...credentials.env };
  }
  const provider = ANTHROPIC_COMPATIBLE_PROVIDERS[credentials.provider];
  return {
    ...provider.env,
    ANTHROPIC_BASE_URL: provider.baseUrl,
    [provider.apiKeyEnvVar]: credentials.apiKey,
  };
}

export function getAnthropicCompatibleCredentialSecret(
  credentials: StoredAnthropicCompatibleCredentials,
): string {
  if (credentials.provider !== CUSTOM_ANTHROPIC_PROVIDER_ID) return credentials.apiKey;
  return credentials.env.ANTHROPIC_AUTH_TOKEN ?? credentials.env.ANTHROPIC_API_KEY ?? "";
}

export function redactAnthropicCompatibleCredentialsSetting(
  value: unknown,
): AnthropicCompatibleCredentialsSummary | null {
  return summarizeAnthropicCompatibleCredentials(parseStoredAnthropicCompatibleCredentials(value));
}
