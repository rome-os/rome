import { describe, expect, it } from "@rstest/core";
import {
  decodePiModelId,
  encodePiModelId,
  isReviewedPiProviderId,
  PI_REVIEWED_ONE_TOKEN_PROVIDERS,
} from "./pi-provider-boundary.js";

describe("Pi provider boundary", () => {
  it("round-trips collision-safe qualified model IDs and rejects noncanonical input", () => {
    const left = encodePiModelId({
      upstreamProvider: "custom/provider",
      upstreamModel: "org/model/v2",
    });
    const right = encodePiModelId({
      upstreamProvider: "custom",
      upstreamModel: "provider/org/model/v2",
    });

    expect(left).toBe("custom%2Fprovider/org%2Fmodel%2Fv2");
    expect(right).toBe("custom/provider%2Forg%2Fmodel%2Fv2");
    expect(left).not.toBe(right);
    expect(decodePiModelId(left)).toEqual({
      upstreamProvider: "custom/provider",
      upstreamModel: "org/model/v2",
    });

    for (const invalid of [
      "bare-model",
      "/model",
      "provider/",
      "one/two/three",
      "provider/bad%2fcanonical",
      "provider/bad%",
      "provider/model%00",
    ]) {
      expect(() => decodePiModelId(invalid)).toThrow("Choose a valid qualified Pi model.");
      try {
        decodePiModelId(invalid);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain(invalid);
      }
    }
  });

  it("matches the closed reviewed one-token provider catalog", () => {
    const expectedProviders = [
      { id: "anthropic", name: "Anthropic" },
      { id: "ant-ling", name: "Ant Ling" },
      { id: "openai", name: "OpenAI" },
      { id: "deepseek", name: "DeepSeek" },
      { id: "nvidia", name: "NVIDIA NIM" },
      { id: "google", name: "Google Gemini" },
      { id: "mistral", name: "Mistral" },
      { id: "groq", name: "Groq" },
      { id: "cerebras", name: "Cerebras" },
      { id: "xai", name: "xAI" },
      { id: "openrouter", name: "OpenRouter" },
      { id: "vercel-ai-gateway", name: "Vercel AI Gateway" },
      { id: "radius", name: "Radius" },
      { id: "huggingface", name: "Hugging Face" },
      { id: "fireworks", name: "Fireworks" },
      { id: "together", name: "Together AI" },
      { id: "baseten", name: "Baseten" },
      { id: "opencode", name: "OpenCode Zen" },
      { id: "opencode-go", name: "OpenCode Go" },
      { id: "zai", name: "ZAI Global" },
      { id: "zai-coding-cn", name: "ZAI China" },
      { id: "kimi-coding", name: "Kimi For Coding" },
      { id: "moonshotai", name: "Moonshot AI (global Kimi Platform)" },
      { id: "moonshotai-cn", name: "Moonshot AI China (Kimi Platform)" },
      { id: "meta", name: "Meta" },
      { id: "minimax", name: "MiniMax" },
      { id: "minimax-cn", name: "MiniMax China" },
      { id: "qwen-token-plan", name: "Qwen Token Plan" },
      { id: "qwen-token-plan-individual", name: "Qwen Token Plan (Individual)" },
      { id: "qwen-token-plan-cn", name: "Qwen Token Plan (China)" },
      { id: "xiaomi", name: "Xiaomi MiMo" },
      { id: "xiaomi-token-plan-cn", name: "Xiaomi MiMo Token Plan (China)" },
      { id: "xiaomi-token-plan-ams", name: "Xiaomi MiMo Token Plan (Amsterdam)" },
      { id: "xiaomi-token-plan-sgp", name: "Xiaomi MiMo Token Plan (Singapore)" },
    ];

    expect(PI_REVIEWED_ONE_TOKEN_PROVIDERS).toEqual(expectedProviders);
    expect(new Set(PI_REVIEWED_ONE_TOKEN_PROVIDERS.map((provider) => provider.id)).size).toBe(
      PI_REVIEWED_ONE_TOKEN_PROVIDERS.length,
    );
    expect(isReviewedPiProviderId("anthropic")).toBe(true);
    expect(isReviewedPiProviderId("future-provider")).toBe(false);
  });
});
