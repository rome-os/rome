import { CredentialSynchronizationError, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createPiModelRuntime,
  qualifyPiModelId,
  type PiModelDescriptor,
} from "./pi-sdk-prototype.js";

/**
 * Product-reviewed one-token provider boundary. This list is deliberately
 * closed: a new Pi provider must not appear in Rome merely because its SDK
 * metadata happens to expose an API-key login hook.
 */
export const PI_PROTOTYPE_ONE_TOKEN_PROVIDERS = [
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
  ["meta", "Meta"],
  ["minimax", "MiniMax"],
  ["minimax-cn", "MiniMax China"],
  ["qwen-token-plan", "Qwen Token Plan (existing catalog)"],
  ["qwen-token-plan-individual", "Qwen Token Plan (Individual)"],
  ["qwen-token-plan-cn", "Qwen Token Plan (China)"],
  ["xiaomi", "Xiaomi MiMo"],
  ["xiaomi-token-plan-cn", "Xiaomi MiMo Token Plan (China)"],
  ["xiaomi-token-plan-ams", "Xiaomi MiMo Token Plan (Amsterdam)"],
  ["xiaomi-token-plan-sgp", "Xiaomi MiMo Token Plan (Singapore)"],
] as const;

const REVIEWED_PROVIDER_NAMES = new Map<string, string>(PI_PROTOTYPE_ONE_TOKEN_PROVIDERS);

export type PiPrototypeCredentialSource = "stored" | "environment" | "none";

export interface PiPrototypeProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  credentialSource: PiPrototypeCredentialSource;
  storedCredentialType?: "api_key" | "oauth";
  externalSource?: string;
  modelCount: number;
}

export interface PiPrototypeConfigurationStatus {
  providers: PiPrototypeProviderStatus[];
  models: PiModelDescriptor[];
  configurationValid: boolean;
  catalogStatus: "models-available" | "no-models" | "discovery-failed";
  /** Presence/catalog discovery is not a billable provider validity probe. */
  liveValidity: "not-verified";
  discoveryFailedProviders: string[];
}

export type PiTokenValidation = { ok: true; token: string } | { ok: false; error: string };

export function validatePiPrototypeToken(input: unknown): PiTokenValidation {
  if (typeof input !== "string") {
    return { ok: false, error: "Enter an API token." };
  }
  if (input.length > 8_192) {
    return { ok: false, error: "The API token must be 8,192 characters or fewer." };
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(input)) {
    return {
      ok: false,
      error: "The API token must not contain line breaks or control characters.",
    };
  }
  const token = input.trim();
  if (!token) return { ok: false, error: "Enter an API token." };
  if (token.startsWith("$") || token.startsWith("!")) {
    return {
      ok: false,
      error: "Enter the literal token value, not a Pi $ENV or !command expression.",
    };
  }
  return { ok: true, token };
}

export function listInstalledOneTokenProviders(runtime: ModelRuntime): Array<{
  id: string;
  name: string;
}> {
  const installed = new Set(runtime.getProviders().map((provider) => provider.id));
  return PI_PROTOTYPE_ONE_TOKEN_PROVIDERS.flatMap(([id, name]) =>
    installed.has(id) ? [{ id, name }] : [],
  );
}

function isReviewedInstalledProvider(runtime: ModelRuntime, providerId: string): boolean {
  return REVIEWED_PROVIDER_NAMES.has(providerId) && runtime.getProvider(providerId) !== undefined;
}

export async function readPiPrototypeConfiguration(
  runtime: ModelRuntime,
  options: { refreshProvider?: string } = {},
): Promise<PiPrototypeConfigurationStatus> {
  const installed = listInstalledOneTokenProviders(runtime);
  const installedIds = new Set(installed.map((provider) => provider.id));
  let discoveryFailedProviders: string[] = [];

  if (options.refreshProvider && installedIds.has(options.refreshProvider)) {
    try {
      const refresh = await runtime.refresh({
        providers: [options.refreshProvider],
        allowNetwork: true,
        force: true,
        signal: AbortSignal.timeout(15_000),
      });
      discoveryFailedProviders = [...refresh.errors.keys()].filter((id) => installedIds.has(id));
      if (refresh.aborted && !discoveryFailedProviders.includes(options.refreshProvider)) {
        discoveryFailedProviders.push(options.refreshProvider);
      }
    } catch {
      discoveryFailedProviders = [options.refreshProvider];
    }
  }

  const [storedCredentials, availableByProvider, authByProvider] = await Promise.all([
    runtime.listCredentials(),
    Promise.all(
      installed.map(async ({ id }) => {
        try {
          return [id, await runtime.getAvailable(id)] as const;
        } catch {
          if (!discoveryFailedProviders.includes(id)) discoveryFailedProviders.push(id);
          return [id, []] as const;
        }
      }),
    ),
    Promise.all(
      installed.map(async ({ id }) => {
        try {
          return [id, await runtime.checkAuth(id)] as const;
        } catch {
          return [id, undefined] as const;
        }
      }),
    ),
  ]);
  const storedByProvider = new Map(storedCredentials.map((entry) => [entry.providerId, entry]));
  const effectiveAuth = new Map(authByProvider);
  const models: PiModelDescriptor[] = availableByProvider.flatMap(([, available]) =>
    available.map((model) => ({
      qualifiedModelId: qualifyPiModelId(model.provider, model.id),
      upstreamProvider: model.provider,
      modelId: model.id,
      name: model.name,
      api: model.api,
      input: [...model.input],
      reasoning: model.reasoning,
    })),
  );
  models.sort((left, right) => left.qualifiedModelId.localeCompare(right.qualifiedModelId));
  const modelCounts = new Map<string, number>();
  for (const model of models) {
    modelCounts.set(model.upstreamProvider, (modelCounts.get(model.upstreamProvider) ?? 0) + 1);
  }

  const providers = installed.map(({ id, name }) => {
    const stored = storedByProvider.get(id);
    const auth = effectiveAuth.get(id);
    const credentialSource: PiPrototypeCredentialSource = stored
      ? "stored"
      : auth
        ? "environment"
        : "none";
    return {
      id,
      name,
      configured: stored !== undefined || auth !== undefined,
      credentialSource,
      ...(stored ? { storedCredentialType: stored.type } : {}),
      ...(credentialSource === "environment" && auth?.source
        ? { externalSource: auth.source }
        : {}),
      modelCount: modelCounts.get(id) ?? 0,
    } satisfies PiPrototypeProviderStatus;
  });

  const configurationValid = runtime.getError() === undefined;
  return {
    providers,
    models,
    configurationValid,
    catalogStatus: !configurationValid
      ? "discovery-failed"
      : models.length
        ? "models-available"
        : "no-models",
    liveValidity: "not-verified",
    discoveryFailedProviders,
  };
}

async function submitApiKeyLogin(
  runtime: ModelRuntime,
  providerId: string,
  token: string,
): Promise<void> {
  let promptCount = 0;
  await runtime.login(providerId, "api_key", {
    async prompt(prompt) {
      promptCount += 1;
      if (promptCount !== 1 || (prompt.type !== "secret" && prompt.type !== "text")) {
        throw new Error("Provider requires more than one token field");
      }
      return token;
    },
    notify() {
      // A one-token credential write has no browser/OAuth interaction to relay.
    },
  });
}

export async function savePiPrototypeCredential(
  providerId: string,
  tokenInput: unknown,
  confirmReplace: boolean,
  suppliedRuntime?: ModelRuntime,
): Promise<{
  credentialPersisted: true;
  synchronizationSucceeded: boolean;
  status: PiPrototypeConfigurationStatus;
}> {
  const runtime = suppliedRuntime ?? (await createPiModelRuntime({ refreshOnCreate: false }));
  if (!isReviewedInstalledProvider(runtime, providerId)) {
    throw new Error("Unsupported Pi provider for the one-token prototype.");
  }
  const validated = validatePiPrototypeToken(tokenInput);
  if (!validated.ok) throw new Error(validated.error);

  const existing = (await runtime.listCredentials()).find((item) => item.providerId === providerId);
  if (existing && !confirmReplace) {
    throw new Error("Confirm replacement of the existing Pi-stored credential.");
  }

  let synchronizationSucceeded = true;
  try {
    await submitApiKeyLogin(runtime, providerId, validated.token);
  } catch (error) {
    if (!(error instanceof CredentialSynchronizationError)) throw error;
    synchronizationSucceeded = false;
  }

  const status = await readPiPrototypeConfiguration(runtime, { refreshProvider: providerId });
  return { credentialPersisted: true, synchronizationSucceeded, status };
}

export async function removePiPrototypeCredential(
  providerId: string,
  suppliedRuntime?: ModelRuntime,
): Promise<{
  credentialRemoved: boolean;
  synchronizationSucceeded: boolean;
  status: PiPrototypeConfigurationStatus;
}> {
  const runtime = suppliedRuntime ?? (await createPiModelRuntime({ refreshOnCreate: false }));
  if (!isReviewedInstalledProvider(runtime, providerId)) {
    throw new Error("Unsupported Pi provider for the one-token prototype.");
  }
  const stored = (await runtime.listCredentials()).some((item) => item.providerId === providerId);
  if (!stored) {
    return {
      credentialRemoved: false,
      synchronizationSucceeded: true,
      status: await readPiPrototypeConfiguration(runtime),
    };
  }

  let synchronizationSucceeded = true;
  try {
    await runtime.logout(providerId);
  } catch (error) {
    if (!(error instanceof CredentialSynchronizationError)) throw error;
    synchronizationSucceeded = false;
  }
  return {
    credentialRemoved: true,
    synchronizationSucceeded,
    status: await readPiPrototypeConfiguration(runtime, { refreshProvider: providerId }),
  };
}
