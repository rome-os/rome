export type PiCredentialSource = "stored" | "environment" | "none";

// Reviewed one-token providers. This is shared with the settings fixture so
// development mode cannot silently present a different Pi catalog than core.
export const PI_PROVIDER_CATALOG = [
  ["anthropic", "Anthropic"],
  ["ant-ling", "Ant Ling"],
  ["openai", "OpenAI"],
  ["deepseek", "DeepSeek"],
  ["nvidia", "NVIDIA NIM"],
  ["google", "Google Gemini"],
  ["mistral", "Mistral"],
  ["groq", "Groq"],
  ["cerebras", "Cerebras"],
  ["xai", "xAI"],
  ["openrouter", "OpenRouter"],
  ["vercel-ai-gateway", "Vercel AI Gateway"],
  ["radius", "Radius"],
  ["huggingface", "Hugging Face"],
  ["fireworks", "Fireworks"],
  ["together", "Together AI"],
  ["baseten", "Baseten"],
  ["opencode", "OpenCode Zen"],
  ["opencode-go", "OpenCode Go"],
  ["zai", "ZAI Global"],
  ["zai-coding-cn", "ZAI China"],
  ["kimi-coding", "Kimi For Coding"],
  ["moonshotai", "Moonshot AI (global Kimi Platform)"],
  ["moonshotai-cn", "Moonshot AI China (Kimi Platform)"],
  ["meta", "Meta"],
  ["minimax", "MiniMax"],
  ["minimax-cn", "MiniMax China"],
  ["qwen-token-plan", "Qwen Token Plan"],
  ["qwen-token-plan-individual", "Qwen Token Plan (Individual)"],
  ["qwen-token-plan-cn", "Qwen Token Plan (China)"],
  ["xiaomi", "Xiaomi MiMo"],
  ["xiaomi-token-plan-cn", "Xiaomi MiMo Token Plan (China)"],
  ["xiaomi-token-plan-ams", "Xiaomi MiMo Token Plan (Amsterdam)"],
  ["xiaomi-token-plan-sgp", "Xiaomi MiMo Token Plan (Singapore)"],
] as const;

export interface PiProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  credentialSource: PiCredentialSource;
  storedCredentialType?: "api_key" | "oauth";
  externalSource?: string;
  modelCount: number;
}

export interface PiDiscoveredModel {
  qualifiedModelId: string;
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  api: string;
  input: ("text" | "image")[];
  reasoning: boolean;
}

export type PiCatalogStatus = "models-available" | "no-models" | "discovery-failed";

export interface PiSettingsStatus {
  providers: PiProviderStatus[];
  models: PiDiscoveredModel[];
  catalogStatus: PiCatalogStatus;
  liveValidity: "not-verified";
  discoveryFailedProviders: string[];
}

export interface PiCredentialMutationResult {
  credentialPersisted: boolean;
  synchronizationSucceeded: boolean;
  status: PiSettingsStatus;
}
