export const PI_PROVIDER_ID = "pi" as const;

const QUALIFIED_MODEL_SEPARATOR = "/";
const UNSAFE_IDENTIFIER_CHARACTER = /[\p{Cc}\p{Cs}]/u;

export interface PiModelId {
  upstreamProvider: string;
  upstreamModel: string;
}

function invalidModelId(): Error {
  return new Error("Choose a valid qualified Pi model.");
}

function encodeModelIdPart(value: string): string {
  if (!value || UNSAFE_IDENTIFIER_CHARACTER.test(value)) throw invalidModelId();
  try {
    return encodeURIComponent(value);
  } catch {
    throw invalidModelId();
  }
}

/** Encodes both parts canonically so either part may itself contain `/`. */
export function encodePiModelId(modelId: PiModelId): string {
  return `${encodeModelIdPart(modelId.upstreamProvider)}${QUALIFIED_MODEL_SEPARATOR}${encodeModelIdPart(modelId.upstreamModel)}`;
}

/** Decodes only canonical qualified IDs. The error never includes the rejected value. */
export function decodePiModelId(qualifiedModelId: string): PiModelId {
  const separator = qualifiedModelId.indexOf(QUALIFIED_MODEL_SEPARATOR);
  if (
    separator <= 0 ||
    separator === qualifiedModelId.length - 1 ||
    separator !== qualifiedModelId.lastIndexOf(QUALIFIED_MODEL_SEPARATOR)
  ) {
    throw invalidModelId();
  }

  try {
    const modelId = {
      upstreamProvider: decodeURIComponent(qualifiedModelId.slice(0, separator)),
      upstreamModel: decodeURIComponent(qualifiedModelId.slice(separator + 1)),
    };
    if (encodePiModelId(modelId) !== qualifiedModelId) throw invalidModelId();
    return modelId;
  } catch {
    throw invalidModelId();
  }
}

/** Product-reviewed providers eligible for the eventual one-token Pi form. */
export const PI_REVIEWED_ONE_TOKEN_PROVIDERS = [
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
] as const;

export type PiReviewedProviderId = (typeof PI_REVIEWED_ONE_TOKEN_PROVIDERS)[number]["id"];

export function isReviewedPiProviderId(providerId: string): providerId is PiReviewedProviderId {
  return PI_REVIEWED_ONE_TOKEN_PROVIDERS.some((provider) => provider.id === providerId);
}
