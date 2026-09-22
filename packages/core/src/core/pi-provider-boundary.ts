import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentAccounting } from "../types.js";

export const PI_PROVIDER_ID = "pi" as const;

const QUALIFIED_MODEL_SEPARATOR = "/";
const MAX_TOKEN_LENGTH = 8_192;
const UNSAFE_IDENTIFIER_CHARACTER = /[\p{Cc}\p{Cs}]/u;

export interface PiModelId {
  upstreamProvider: string;
  upstreamModel: string;
}

export type PiPublicErrorCode =
  | "catalog-unavailable"
  | "credential-remove-failed"
  | "credential-save-failed"
  | "invalid-model-id"
  | "invalid-token"
  | "provider-not-installed"
  | "remove-confirmation-required"
  | "replace-confirmation-required"
  | "status-unavailable"
  | "unsupported-provider";

export interface PiPublicError {
  code: PiPublicErrorCode;
  message: string;
  retryable: boolean;
}

const PUBLIC_ERRORS: Record<PiPublicErrorCode, PiPublicError> = {
  "catalog-unavailable": {
    code: "catalog-unavailable",
    message: "Pi model discovery failed. Refresh the provider and try again.",
    retryable: true,
  },
  "credential-remove-failed": {
    code: "credential-remove-failed",
    message: "Pi could not remove the stored credential. Try again.",
    retryable: true,
  },
  "credential-save-failed": {
    code: "credential-save-failed",
    message: "Pi could not store the credential. Check the provider and try again.",
    retryable: true,
  },
  "invalid-model-id": {
    code: "invalid-model-id",
    message: "Choose a valid qualified Pi model.",
    retryable: false,
  },
  "invalid-token": {
    code: "invalid-token",
    message: "Enter a literal API token of 8,192 characters or fewer without control characters.",
    retryable: false,
  },
  "provider-not-installed": {
    code: "provider-not-installed",
    message: "This reviewed Pi provider is not present in the supported Pi installation.",
    retryable: false,
  },
  "remove-confirmation-required": {
    code: "remove-confirmation-required",
    message: "Confirm removal of this provider's stored Pi credential.",
    retryable: false,
  },
  "replace-confirmation-required": {
    code: "replace-confirmation-required",
    message: "Confirm replacement of this provider's stored Pi credential.",
    retryable: false,
  },
  "status-unavailable": {
    code: "status-unavailable",
    message: "Pi configuration status is unavailable. Try again.",
    retryable: true,
  },
  "unsupported-provider": {
    code: "unsupported-provider",
    message: "Choose a reviewed one-token Pi provider.",
    retryable: false,
  },
};

function publicError(code: PiPublicErrorCode): PiPublicError {
  return { ...PUBLIC_ERRORS[code] };
}

function isSafeIdentifierPart(value: string): boolean {
  return value.length > 0 && !UNSAFE_IDENTIFIER_CHARACTER.test(value);
}

function encodeModelIdPart(value: string): string {
  if (!isSafeIdentifierPart(value)) {
    throw publicError("invalid-model-id");
  }
  try {
    return encodeURIComponent(value);
  } catch {
    throw publicError("invalid-model-id");
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
    throw publicError("invalid-model-id");
  }

  try {
    const modelId = {
      upstreamProvider: decodeURIComponent(qualifiedModelId.slice(0, separator)),
      upstreamModel: decodeURIComponent(qualifiedModelId.slice(separator + 1)),
    };
    if (encodePiModelId(modelId) !== qualifiedModelId) {
      throw publicError("invalid-model-id");
    }
    return modelId;
  } catch {
    throw publicError("invalid-model-id");
  }
}

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
  { id: "meta", name: "Meta" },
  { id: "minimax", name: "MiniMax" },
  { id: "minimax-cn", name: "MiniMax China" },
  { id: "qwen-token-plan", name: "Qwen Token Plan (existing catalog)" },
  { id: "qwen-token-plan-individual", name: "Qwen Token Plan (Individual)" },
  { id: "qwen-token-plan-cn", name: "Qwen Token Plan (China)" },
  { id: "xiaomi", name: "Xiaomi MiMo" },
  { id: "xiaomi-token-plan-cn", name: "Xiaomi MiMo Token Plan (China)" },
  { id: "xiaomi-token-plan-ams", name: "Xiaomi MiMo Token Plan (Amsterdam)" },
  { id: "xiaomi-token-plan-sgp", name: "Xiaomi MiMo Token Plan (Singapore)" },
] as const;

export type PiReviewedProviderId = (typeof PI_REVIEWED_ONE_TOKEN_PROVIDERS)[number]["id"];

const REVIEWED_PROVIDER_BY_ID = new Map<string, (typeof PI_REVIEWED_ONE_TOKEN_PROVIDERS)[number]>(
  PI_REVIEWED_ONE_TOKEN_PROVIDERS.map((provider) => [provider.id, provider]),
);

export interface PiRuntimeModel {
  upstreamProvider: string;
  upstreamModel: string;
  displayName: string;
  input: readonly ("text" | "image")[];
  origin: "built-in" | "custom";
  romeCompatibility: "reviewed-text-and-tools" | "unreviewed";
}

type PiSdkCredentialInfo = Awaited<ReturnType<ModelRuntime["listCredentials"]>>[number];
export type PiStoredCredentialType = Extract<PiSdkCredentialInfo["type"], "api_key" | "oauth">;

export interface PiRuntimeCredentialStatus {
  stored?: { type: PiStoredCredentialType };
  external?: { kind: "environment" | "other" };
}

export interface PiRuntimeMutationResult {
  credential: PiRuntimeCredentialStatus;
  synchronization: "succeeded" | "failed";
}

/**
 * Keeps SDK access outside the public boundary. A mutation operation must return a committed
 * result, rather than throw, when only later SDK synchronization fails.
 */
export interface PiRuntimeOperations {
  listInstalledProviderIds(): Promise<readonly string[]>;
  listAvailableModels(providerId: string): Promise<readonly PiRuntimeModel[]>;
  getCredentialStatus(providerId: string): Promise<PiRuntimeCredentialStatus>;
  saveLiteralToken(providerId: string, token: string): Promise<PiRuntimeMutationResult>;
  removeStoredCredential(providerId: string): Promise<PiRuntimeMutationResult>;
  refreshProvider(providerId: string): Promise<"succeeded" | "failed">;
}

export interface PiInstalledProvider {
  id: PiReviewedProviderId;
  name: string;
}

export interface PiEligibleModel {
  qualifiedModelId: string;
  upstreamProvider: PiReviewedProviderId;
  upstreamModel: string;
  providerName: string;
  displayName: string;
  input: readonly ("text" | "image")[];
}

export interface PiCatalogSnapshot {
  providers: PiInstalledProvider[];
  models: PiEligibleModel[];
  catalogStatus: "models-available" | "no-models" | "discovery-failed";
  discoveryFailedProviderIds: PiReviewedProviderId[];
}

export type PiCatalogResult =
  | { ok: true; snapshot: PiCatalogSnapshot }
  | { ok: false; error: PiPublicError };

interface CatalogLoadOptions {
  providerId?: string;
  installedProviders?: PiInstalledProvider[];
  excludedLiteral?: string;
  forceDiscoveryFailure?: boolean;
}

function reviewedProvider(providerId: string): PiInstalledProvider | undefined {
  const provider = REVIEWED_PROVIDER_BY_ID.get(providerId);
  return provider ? { id: provider.id as PiReviewedProviderId, name: provider.name } : undefined;
}

async function loadCatalog(
  runtime: PiRuntimeOperations,
  options: CatalogLoadOptions = {},
): Promise<PiCatalogResult> {
  let providers: PiInstalledProvider[];
  if (options.installedProviders) {
    providers = options.installedProviders;
  } else {
    let installedIds: readonly string[];
    try {
      installedIds = await runtime.listInstalledProviderIds();
    } catch {
      return { ok: false, error: publicError("catalog-unavailable") };
    }
    const installed = new Set(installedIds);
    providers = PI_REVIEWED_ONE_TOKEN_PROVIDERS.filter((provider) =>
      installed.has(provider.id),
    ).map((provider) => ({ id: provider.id, name: provider.name }));
  }

  if (options.providerId) {
    const reviewed = reviewedProvider(options.providerId);
    if (!reviewed) {
      return { ok: false, error: publicError("unsupported-provider") };
    }
    if (!providers.some((provider) => provider.id === reviewed.id)) {
      return { ok: false, error: publicError("provider-not-installed") };
    }
    providers = [reviewed];
  }

  const modelsById = new Map<string, PiEligibleModel>();
  const discoveryFailedProviderIds: PiReviewedProviderId[] = [];
  for (const provider of providers) {
    let models: readonly PiRuntimeModel[];
    try {
      models = await runtime.listAvailableModels(provider.id);
    } catch {
      discoveryFailedProviderIds.push(provider.id);
      continue;
    }

    for (const model of models) {
      if (
        model.upstreamProvider !== provider.id ||
        model.origin !== "built-in" ||
        model.romeCompatibility !== "reviewed-text-and-tools" ||
        !model.input.includes("text") ||
        !isSafeIdentifierPart(model.displayName) ||
        (options.excludedLiteral &&
          (model.upstreamModel.includes(options.excludedLiteral) ||
            model.displayName.includes(options.excludedLiteral)))
      ) {
        continue;
      }

      let qualifiedModelId: string;
      try {
        qualifiedModelId = encodePiModelId({
          upstreamProvider: provider.id,
          upstreamModel: model.upstreamModel,
        });
      } catch {
        continue;
      }
      if (!modelsById.has(qualifiedModelId)) {
        modelsById.set(qualifiedModelId, {
          qualifiedModelId,
          upstreamProvider: provider.id,
          upstreamModel: model.upstreamModel,
          providerName: provider.name,
          displayName: model.displayName,
          input: [...model.input],
        });
      }
    }
  }

  if (options.forceDiscoveryFailure) {
    for (const provider of providers) {
      if (!discoveryFailedProviderIds.includes(provider.id)) {
        discoveryFailedProviderIds.push(provider.id);
      }
    }
  }
  const models = [...modelsById.values()].sort((left, right) =>
    left.qualifiedModelId.localeCompare(right.qualifiedModelId),
  );
  return {
    ok: true,
    snapshot: {
      providers,
      models,
      catalogStatus: discoveryFailedProviderIds.length
        ? "discovery-failed"
        : models.length
          ? "models-available"
          : "no-models",
      discoveryFailedProviderIds,
    },
  };
}

export class PiCatalog {
  constructor(private readonly runtime: PiRuntimeOperations) {}

  listEligible(providerId?: string): Promise<PiCatalogResult> {
    return loadCatalog(this.runtime, { providerId });
  }
}

export type PiCredentialSource =
  | { source: "stored"; storedType: "api_key" | "oauth" }
  | { source: "external"; externalKind: "environment" | "other" }
  | { source: "none" };

export interface PiProviderStatus extends PiInstalledProvider {
  credential: PiCredentialSource;
  configured: boolean;
  eligibleModelCount: number;
}

export interface PiConfigurationStatus {
  providers: PiProviderStatus[];
  eligibleModels: PiEligibleModel[];
  catalogStatus: PiCatalogSnapshot["catalogStatus"];
  discoveryFailedProviderIds: PiReviewedProviderId[];
  liveValidity: "not-verified";
}

export type PiStatusResult =
  | { ok: true; status: PiConfigurationStatus }
  | { ok: false; error: PiPublicError };

export type PiOperationFailure = {
  ok: false;
  error: PiPublicError;
  status?: PiConfigurationStatus;
};

export type PiSaveResult =
  | {
      ok: true;
      credentialPersisted: true;
      synchronizationSucceeded: boolean;
      outcome: "models-available" | "no-models" | "credential-saved/discovery-failed";
      status: PiConfigurationStatus;
    }
  | PiOperationFailure;

export type PiRemoveResult =
  | {
      ok: true;
      credentialRemoved: boolean;
      synchronizationSucceeded: boolean;
      status: PiConfigurationStatus;
    }
  | PiOperationFailure;

export type PiRefreshResult = { ok: true; status: PiConfigurationStatus } | PiOperationFailure;

function credentialSource(status: PiRuntimeCredentialStatus): PiCredentialSource {
  if (status.stored?.type === "api_key" || status.stored?.type === "oauth") {
    return { source: "stored", storedType: status.stored.type };
  }
  if (status.external?.kind === "environment" || status.external?.kind === "other") {
    return { source: "external", externalKind: status.external.kind };
  }
  return { source: "none" };
}

function validateLiteralToken(
  input: unknown,
): { ok: true; token: string } | { ok: false; error: PiPublicError } {
  if (typeof input !== "string" || UNSAFE_IDENTIFIER_CHARACTER.test(input)) {
    return { ok: false, error: publicError("invalid-token") };
  }
  const token = input.trim();
  if (
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    token.startsWith("$") ||
    token.startsWith("!")
  ) {
    return { ok: false, error: publicError("invalid-token") };
  }
  return { ok: true, token };
}

interface StatusOptions extends CatalogLoadOptions {
  credentialOverrides?: ReadonlyMap<string, PiRuntimeCredentialStatus>;
}

export class PiConfiguration {
  constructor(private readonly runtime: PiRuntimeOperations) {}

  status(providerId?: string): Promise<PiStatusResult> {
    return this.readStatus({ providerId });
  }

  async saveLiteralToken(input: {
    providerId: string;
    token: unknown;
    confirmReplace: boolean;
  }): Promise<PiSaveResult> {
    const token = validateLiteralToken(input.token);
    if (!token.ok) return token;

    const prior = await this.readStatus({
      providerId: input.providerId,
      excludedLiteral: token.token,
    });
    if (!prior.ok) return prior;
    const provider = prior.status.providers[0];
    if (provider.credential.source === "stored" && !input.confirmReplace) {
      return {
        ok: false,
        error: publicError("replace-confirmation-required"),
        status: prior.status,
      };
    }

    let mutation: PiRuntimeMutationResult;
    try {
      mutation = await this.runtime.saveLiteralToken(input.providerId, token.token);
    } catch {
      return {
        ok: false,
        error: publicError("credential-save-failed"),
        status: prior.status,
      };
    }

    const installedProviders = [{ id: provider.id, name: provider.name }];
    const credentialOverrides = new Map<string, PiRuntimeCredentialStatus>([
      [provider.id, { stored: { type: "api_key" }, external: mutation.credential.external }],
    ]);
    const statusResult = await this.readStatus({
      providerId: provider.id,
      installedProviders,
      credentialOverrides,
      excludedLiteral: token.token,
      forceDiscoveryFailure: mutation.synchronization === "failed",
    });
    if (!statusResult.ok) {
      return {
        ok: false,
        error: publicError("status-unavailable"),
        status: prior.status,
      };
    }

    const outcome =
      statusResult.status.catalogStatus === "discovery-failed"
        ? "credential-saved/discovery-failed"
        : statusResult.status.catalogStatus;
    return {
      ok: true,
      credentialPersisted: true,
      synchronizationSucceeded: mutation.synchronization === "succeeded",
      outcome,
      status: statusResult.status,
    };
  }

  async removeStoredCredential(input: {
    providerId: string;
    confirmRemove: boolean;
  }): Promise<PiRemoveResult> {
    if (!input.confirmRemove) {
      return { ok: false, error: publicError("remove-confirmation-required") };
    }
    const prior = await this.status(input.providerId);
    if (!prior.ok) return prior;
    const provider = prior.status.providers[0];
    if (provider.credential.source !== "stored") {
      return {
        ok: true,
        credentialRemoved: false,
        synchronizationSucceeded: true,
        status: prior.status,
      };
    }

    let mutation: PiRuntimeMutationResult;
    try {
      mutation = await this.runtime.removeStoredCredential(input.providerId);
    } catch {
      return {
        ok: false,
        error: publicError("credential-remove-failed"),
        status: prior.status,
      };
    }

    const statusResult = await this.readStatus({
      providerId: provider.id,
      installedProviders: [{ id: provider.id, name: provider.name }],
      credentialOverrides: new Map([[provider.id, mutation.credential]]),
      forceDiscoveryFailure: mutation.synchronization === "failed",
    });
    if (!statusResult.ok) {
      return {
        ok: false,
        error: publicError("status-unavailable"),
        status: prior.status,
      };
    }
    return {
      ok: true,
      credentialRemoved: true,
      synchronizationSucceeded: mutation.synchronization === "succeeded",
      status: statusResult.status,
    };
  }

  async refresh(providerId: string): Promise<PiRefreshResult> {
    const prior = await this.status(providerId);
    if (!prior.ok) return prior;
    let synchronization: "succeeded" | "failed";
    try {
      synchronization = await this.runtime.refreshProvider(providerId);
    } catch {
      synchronization = "failed";
    }
    const provider = prior.status.providers[0];
    const refreshed = await this.readStatus({
      providerId,
      installedProviders: [{ id: provider.id, name: provider.name }],
      forceDiscoveryFailure: synchronization === "failed",
    });
    if (!refreshed.ok) {
      return { ok: false, error: refreshed.error, status: prior.status };
    }
    return refreshed;
  }

  private async readStatus(options: StatusOptions): Promise<PiStatusResult> {
    const catalog = await loadCatalog(this.runtime, options);
    if (!catalog.ok) return catalog;

    const providers: PiProviderStatus[] = [];
    for (const provider of catalog.snapshot.providers) {
      let runtimeCredential = options.credentialOverrides?.get(provider.id);
      if (!runtimeCredential) {
        try {
          runtimeCredential = await this.runtime.getCredentialStatus(provider.id);
        } catch {
          return { ok: false, error: publicError("status-unavailable") };
        }
      }
      const credential = credentialSource(runtimeCredential);
      providers.push({
        ...provider,
        credential,
        configured: credential.source !== "none",
        eligibleModelCount: catalog.snapshot.models.filter(
          (model) => model.upstreamProvider === provider.id,
        ).length,
      });
    }

    return {
      ok: true,
      status: {
        providers,
        eligibleModels: catalog.snapshot.models,
        catalogStatus: catalog.snapshot.catalogStatus,
        discoveryFailedProviderIds: catalog.snapshot.discoveryFailedProviderIds,
        liveValidity: "not-verified",
      },
    };
  }
}

export interface PiRuntimeUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown };
}

const PI_STOP_REASONS = new Set([
  "pending",
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
]);

function normalizedTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Maps Pi usage into Rome accounting without retaining raw provider fields. */
export function normalizePiAccounting(input: {
  qualifiedModelId: string;
  usage: PiRuntimeUsage;
  stopReason?: unknown;
}): AgentAccounting {
  const modelId = decodePiModelId(input.qualifiedModelId);
  const cost = input.usage.cost?.total;
  const stopReason =
    typeof input.stopReason === "string" && PI_STOP_REASONS.has(input.stopReason)
      ? input.stopReason
      : undefined;
  return {
    provider: PI_PROVIDER_ID,
    model: encodePiModelId(modelId),
    usage: {
      inputTokens: normalizedTokenCount(input.usage.input),
      outputTokens: normalizedTokenCount(input.usage.output),
      cacheReadTokens: normalizedTokenCount(input.usage.cacheRead),
      cacheWriteTokens: normalizedTokenCount(input.usage.cacheWrite),
    },
    costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined,
    stopReason,
  };
}
