import { describe, expect, it } from "@rstest/core";
import {
  buildAnthropicCompatibleProviderEnv,
  listAnthropicCompatibleProviderSummaries,
  parseStoredAnthropicCompatibleCredentials,
  summarizeAnthropicCompatibleCredentialsForEditing,
  validateCustomAnthropicEnv,
} from "./anthropic-compatible-providers.js";

describe("anthropic-compatible-providers", () => {
  it("lists the supported Anthropic-compatible providers", () => {
    expect(listAnthropicCompatibleProviderSummaries().map((provider) => provider.id)).toEqual([
      "minimax",
      "minimax-intl",
      "z-ai",
      "kimi",
      "deepseek",
      "meta",
      "custom",
    ]);
  });

  it("builds MiniMax Claude Code environment overrides", () => {
    expect(
      buildAnthropicCompatibleProviderEnv({
        provider: "minimax",
        apiKey: "minimax-key",
        updatedAt: "2026-04-26T00:00:00.000Z",
      }),
    ).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "minimax-key",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_MODEL: "MiniMax-M2.7",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax-M2.7",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax-M2.7",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "MiniMax-M2.7",
    });
  });

  it("builds MiniMax (International) Claude Code environment overrides", () => {
    expect(
      buildAnthropicCompatibleProviderEnv({
        provider: "minimax-intl",
        apiKey: "minimax-intl-key",
        updatedAt: "2026-04-26T00:00:00.000Z",
      }),
    ).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
      ANTHROPIC_AUTH_TOKEN: "minimax-intl-key",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_MODEL: "MiniMax-M2.7",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax-M2.7",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax-M2.7",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "MiniMax-M2.7",
    });
  });

  it("builds Z.ai Claude Code environment overrides", () => {
    expect(
      buildAnthropicCompatibleProviderEnv({
        provider: "z-ai",
        apiKey: "zai-key",
        updatedAt: "2026-04-26T00:00:00.000Z",
      }),
    ).toEqual({
      API_TIMEOUT_MS: "3000000",
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "zai-key",
    });
  });

  it("builds Kimi Claude Code environment overrides", () => {
    expect(
      buildAnthropicCompatibleProviderEnv({
        provider: "kimi",
        apiKey: "kimi-key",
        updatedAt: "2026-04-26T00:00:00.000Z",
      }),
    ).toEqual({
      ENABLE_TOOL_SEARCH: "false",
      ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
      ANTHROPIC_API_KEY: "kimi-key",
    });
  });

  it("builds DeepSeek Claude Code environment overrides", () => {
    expect(
      buildAnthropicCompatibleProviderEnv({
        provider: "deepseek",
        apiKey: "deepseek-key",
        updatedAt: "2026-04-26T00:00:00.000Z",
      }),
    ).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "deepseek-key",
      ANTHROPIC_MODEL: "deepseek-v4-pro[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash",
      CLAUDE_CODE_EFFORT_LEVEL: "high",
    });
  });

  it("builds Meta Claude Code environment overrides", () => {
    expect(
      buildAnthropicCompatibleProviderEnv({
        provider: "meta",
        apiKey: "meta-key",
        updatedAt: "2026-04-26T00:00:00.000Z",
      }),
    ).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.meta.ai",
      ANTHROPIC_AUTH_TOKEN: "meta-key",
      ANTHROPIC_MODEL: "muse-spark-1.1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "muse-spark-1.1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "muse-spark-1.1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "muse-spark-1.1",
      CLAUDE_CODE_SUBAGENT_MODEL: "muse-spark-1.1",
    });
  });

  it("builds an exact custom Claude Code environment", () => {
    const env = {
      ANTHROPIC_AUTH_TOKEN: "ark-key",
      ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan",
      ANTHROPIC_MODEL: "ep-model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "ep-model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "ep-model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "ep-model",
      CLAUDE_CODE_SUBAGENT_MODEL: "ep-model",
    };
    expect(
      buildAnthropicCompatibleProviderEnv({
        provider: "custom",
        env,
        updatedAt: "2026-07-16T00:00:00.000Z",
      }),
    ).toEqual(env);
  });

  it("validates custom environments and rejects unsafe process variables", () => {
    expect(
      validateCustomAnthropicEnv({
        ANTHROPIC_AUTH_TOKEN: "ark-key",
        ANTHROPIC_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan",
        ANTHROPIC_MODEL: "ep-model",
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateCustomAnthropicEnv({
        ANTHROPIC_AUTH_TOKEN: "ark-key",
        NODE_OPTIONS: "--require=/tmp/inject.js",
      }),
    ).toEqual({ ok: false, error: "Environment variable is not allowed: NODE_OPTIONS" });
    expect(
      validateCustomAnthropicEnv({
        ANTHROPIC_AUTH_TOKEN: "one",
        ANTHROPIC_API_KEY: "two",
      }),
    ).toEqual({
      ok: false,
      error: "Provide exactly one of ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY",
    });
    expect(
      validateCustomAnthropicEnv({
        ANTHROPIC_AUTH_TOKEN: "one",
        ANTHROPIC_API_KEY: "",
      }),
    ).toEqual({
      ok: false,
      error: "Provide exactly one of ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY",
    });
  });

  it("returns the complete custom environment for editing", () => {
    expect(
      summarizeAnthropicCompatibleCredentialsForEditing({
        provider: "custom",
        env: {
          ANTHROPIC_AUTH_TOKEN: "ark-key",
          ANTHROPIC_BASE_URL: "https://ark.example.com/api/plan",
          ANTHROPIC_MODEL: "ep-model",
        },
        updatedAt: "2026-07-16T00:00:00.000Z",
      }),
    ).toEqual({
      provider: "custom",
      providerName: "Custom",
      hasApiKey: true,
      updatedAt: "2026-07-16T00:00:00.000Z",
      env: {
        ANTHROPIC_AUTH_TOKEN: "ark-key",
        ANTHROPIC_BASE_URL: "https://ark.example.com/api/plan",
        ANTHROPIC_MODEL: "ep-model",
      },
    });
  });

  it("rejects malformed stored credentials", () => {
    expect(parseStoredAnthropicCompatibleCredentials(null)).toBeNull();
    expect(
      parseStoredAnthropicCompatibleCredentials({ provider: "unknown", apiKey: "key" }),
    ).toBeNull();
    expect(parseStoredAnthropicCompatibleCredentials({ provider: "kimi", apiKey: "" })).toBeNull();
    expect(
      parseStoredAnthropicCompatibleCredentials({
        provider: "custom",
        env: { ANTHROPIC_AUTH_TOKEN: "key", PATH: "/tmp" },
        updatedAt: "2026-07-16T00:00:00.000Z",
      }),
    ).toBeNull();
  });
});
