import { InvalidPiModelIdentityError, qualifyPiModelId } from "./identity.js";

export interface PiSdkProvider {
  id: string;
  auth: {
    apiKey?: {
      login?: unknown;
    };
  };
}

export interface PiSdkModel {
  id: string;
  name: string;
  provider: string;
  api: string;
  input: readonly ("text" | "image")[];
  reasoning: boolean;
}

export interface PiCatalogRuntime {
  getProviders(): readonly PiSdkProvider[];
  getProvider(providerId: string): PiSdkProvider | undefined;
  getModels(providerId?: string): readonly PiSdkModel[];
}

export interface PiReviewedProvider {
  id: string;
  name: string;
  environmentKeys: readonly string[];
}

/**
 * Product-reviewed providers whose official Pi setup can be represented by one
 * opaque token. This is intentionally closed to new SDK providers.
 */
export const PI_ONE_TOKEN_PROVIDERS = [
  {
    id: "anthropic",
    name: "Anthropic",
    environmentKeys: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  },
  { id: "ant-ling", name: "Ant Ling", environmentKeys: ["ANT_LING_API_KEY"] },
  { id: "openai", name: "OpenAI", environmentKeys: ["OPENAI_API_KEY"] },
  { id: "deepseek", name: "DeepSeek", environmentKeys: ["DEEPSEEK_API_KEY"] },
  { id: "nvidia", name: "NVIDIA NIM", environmentKeys: ["NVIDIA_API_KEY"] },
  { id: "google", name: "Google Gemini", environmentKeys: ["GEMINI_API_KEY"] },
  { id: "mistral", name: "Mistral", environmentKeys: ["MISTRAL_API_KEY"] },
  { id: "groq", name: "Groq", environmentKeys: ["GROQ_API_KEY"] },
  { id: "cerebras", name: "Cerebras", environmentKeys: ["CEREBRAS_API_KEY"] },
  { id: "xai", name: "xAI", environmentKeys: ["XAI_API_KEY"] },
  { id: "openrouter", name: "OpenRouter", environmentKeys: ["OPENROUTER_API_KEY"] },
  { id: "vercel-ai-gateway", name: "Vercel AI Gateway", environmentKeys: ["AI_GATEWAY_API_KEY"] },
  { id: "radius", name: "Radius", environmentKeys: ["RADIUS_API_KEY"] },
  { id: "huggingface", name: "Hugging Face", environmentKeys: ["HF_TOKEN"] },
  { id: "fireworks", name: "Fireworks", environmentKeys: ["FIREWORKS_API_KEY"] },
  { id: "together", name: "Together AI", environmentKeys: ["TOGETHER_API_KEY"] },
  { id: "baseten", name: "Baseten", environmentKeys: ["BASETEN_API_KEY"] },
  { id: "opencode", name: "OpenCode Zen", environmentKeys: ["OPENCODE_API_KEY"] },
  { id: "opencode-go", name: "OpenCode Go", environmentKeys: ["OPENCODE_API_KEY"] },
  { id: "zai", name: "ZAI Global", environmentKeys: ["ZAI_API_KEY"] },
  { id: "zai-coding-cn", name: "ZAI China", environmentKeys: ["ZAI_CODING_CN_API_KEY"] },
  { id: "kimi-coding", name: "Kimi For Coding", environmentKeys: ["KIMI_API_KEY"] },
  {
    id: "moonshotai",
    name: "Moonshot AI (global Kimi Platform)",
    environmentKeys: ["MOONSHOT_API_KEY"],
  },
  {
    id: "moonshotai-cn",
    name: "Moonshot AI China (Kimi Platform)",
    environmentKeys: ["MOONSHOT_API_KEY"],
  },
  { id: "meta", name: "Meta", environmentKeys: ["META_API_KEY"] },
  { id: "minimax", name: "MiniMax", environmentKeys: ["MINIMAX_API_KEY"] },
  { id: "minimax-cn", name: "MiniMax China", environmentKeys: ["MINIMAX_CN_API_KEY"] },
  {
    id: "qwen-token-plan",
    name: "Qwen Token Plan (existing catalog)",
    environmentKeys: ["QWEN_TOKEN_PLAN_API_KEY"],
  },
  {
    id: "qwen-token-plan-individual",
    name: "Qwen Token Plan (Individual)",
    environmentKeys: ["QWEN_TOKEN_PLAN_API_KEY"],
  },
  {
    id: "qwen-token-plan-cn",
    name: "Qwen Token Plan (China)",
    environmentKeys: ["QWEN_TOKEN_PLAN_CN_API_KEY"],
  },
  { id: "xiaomi", name: "Xiaomi MiMo", environmentKeys: ["XIAOMI_API_KEY"] },
  {
    id: "xiaomi-token-plan-cn",
    name: "Xiaomi MiMo Token Plan (China)",
    environmentKeys: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  },
  {
    id: "xiaomi-token-plan-ams",
    name: "Xiaomi MiMo Token Plan (Amsterdam)",
    environmentKeys: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  },
  {
    id: "xiaomi-token-plan-sgp",
    name: "Xiaomi MiMo Token Plan (Singapore)",
    environmentKeys: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  },
] as const satisfies readonly PiReviewedProvider[];

const REVIEWED_PROVIDERS = new Map<string, PiReviewedProvider>(
  PI_ONE_TOKEN_PROVIDERS.map((provider) => [provider.id, provider] as const),
);

/** APIs reviewed as supporting Rome's text input and tool-call contract. */
export const PI_ROME_TOOL_CAPABLE_APIS = Object.freeze([
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
  "openai-completions",
  "openai-responses",
  "pi-messages",
]);

const PI_ROME_TOOL_CAPABLE_API_SET = new Set<string>(PI_ROME_TOOL_CAPABLE_APIS);

export interface PiModelDescriptor {
  qualifiedModelId: string;
  upstreamProvider: string;
  modelId: string;
  name: string;
  api: string;
  input: readonly ("text" | "image")[];
  reasoning: boolean;
}

export function getReviewedProvider(providerId: string): PiReviewedProvider | undefined {
  return REVIEWED_PROVIDERS.get(providerId);
}

export function listInstalledOneTokenProviders(runtime: PiCatalogRuntime): PiReviewedProvider[] {
  const installed = new Set(runtime.getProviders().map((provider) => provider.id));
  return PI_ONE_TOKEN_PROVIDERS.filter((reviewed) => {
    if (!installed.has(reviewed.id)) return false;
    const login = runtime.getProvider(reviewed.id)?.auth.apiKey?.login;
    return typeof login === "function";
  });
}

export function isRomeCompatiblePiModel(model: PiSdkModel): boolean {
  return PI_ROME_TOOL_CAPABLE_API_SET.has(model.api) && model.input.includes("text");
}

export function listEligiblePiModels(
  runtime: PiCatalogRuntime,
  configuredProviderIds: ReadonlySet<string>,
  failedProviderIds: ReadonlySet<string> = new Set(),
): PiModelDescriptor[] {
  const installed = new Set(listInstalledOneTokenProviders(runtime).map((provider) => provider.id));
  const models = new Map<string, PiModelDescriptor>();

  for (const model of runtime.getModels()) {
    if (
      !installed.has(model.provider) ||
      !configuredProviderIds.has(model.provider) ||
      failedProviderIds.has(model.provider) ||
      !isRomeCompatiblePiModel(model)
    ) {
      continue;
    }
    let qualifiedModelId: string;
    try {
      qualifiedModelId = qualifyPiModelId(model.provider, model.id);
    } catch (error) {
      if (error instanceof InvalidPiModelIdentityError) continue;
      throw error;
    }
    if (models.has(qualifiedModelId)) continue;
    models.set(qualifiedModelId, {
      qualifiedModelId,
      upstreamProvider: model.provider,
      modelId: model.id,
      name: model.name,
      api: model.api,
      input: [...model.input],
      reasoning: model.reasoning,
    });
  }

  return [...models.values()].sort((left, right) =>
    left.qualifiedModelId.localeCompare(right.qualifiedModelId),
  );
}
