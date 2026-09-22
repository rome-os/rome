import {
  getReviewedProvider,
  listEligiblePiModels,
  listInstalledOneTokenProviders,
  type PiCatalogRuntime,
  type PiModelDescriptor,
  type PiSdkModel,
} from "./catalog.js";

const MAX_TOKEN_LENGTH = 8_192;
const TOKEN_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const DISCOVERY_FAILED_MESSAGE = "Pi model discovery failed. Refresh and try again.";

export type PiCredentialSource = "stored" | "environment" | "external" | "none";
export type PiStoredCredentialType = "api_key" | "oauth";
export type PiStoredCredentialSafety =
  | "literal"
  | "expression"
  | "oauth"
  | "missing"
  | "unreadable";

export interface PiCredentialInfo {
  providerId: string;
  type: PiStoredCredentialType;
}

export interface PiAuthStatus {
  configured: boolean;
  source?:
    | "stored"
    | "runtime"
    | "environment"
    | "fallback"
    | "models_json_key"
    | "models_json_command";
  label?: string;
}

export interface PiRefreshResult {
  aborted: boolean;
  errors: ReadonlyMap<string, unknown>;
}

export interface PiAuthPrompt {
  type: "text" | "secret" | "select" | "manual_code";
}

export interface PiCredentialRuntime extends PiCatalogRuntime {
  listCredentials(): Promise<readonly PiCredentialInfo[]>;
  getProviderAuthStatus(providerId: string): PiAuthStatus;
  getAvailable(providerId: string): Promise<readonly PiSdkModel[]>;
  login(
    providerId: string,
    type: "api_key",
    interaction: {
      prompt(prompt: PiAuthPrompt): Promise<string>;
      notify(event: unknown): void;
    },
  ): Promise<unknown>;
  logout(providerId: string): Promise<void>;
  refresh(options: {
    providers: readonly string[];
    allowNetwork: boolean;
    force: boolean;
    signal: AbortSignal;
  }): Promise<PiRefreshResult>;
}

export interface PiCredentialBoundaryDependencies {
  runtime: PiCredentialRuntime;
  inspectStoredCredential(providerId: string): PiStoredCredentialSafety;
  isCredentialSynchronizationError(error: unknown): boolean;
  environment?: Readonly<Record<string, string | undefined>>;
  refreshTimeoutMs?: number;
}

export interface PiProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  credentialSource: PiCredentialSource;
  storedCredentialType?: PiStoredCredentialType;
  modelCount: number;
  status: "models-available" | "no-models" | "not-configured" | "discovery-failed";
}

export type PiCatalogResult =
  | { kind: "models-available"; models: PiModelDescriptor[] }
  | { kind: "no-models"; models: [] }
  | {
      kind: "discovery-failed";
      models: PiModelDescriptor[];
      failedProviders: string[];
      message: string;
    };

export interface PiConfigurationStatus {
  providers: PiProviderStatus[];
  catalog: PiCatalogResult;
  liveValidity: "not-verified";
}

export type PiTokenValidation =
  | { ok: true; token: string }
  | {
      ok: false;
      reason: "required" | "too-long" | "control-character" | "expression-prefix";
      message: string;
    };

export type PiBoundaryErrorCode =
  | "unsupported-provider"
  | "invalid-token"
  | "replacement-confirmation-required"
  | "removal-confirmation-required"
  | "credential-save-failed"
  | "credential-remove-failed";

export class PiCredentialBoundaryError extends Error {
  constructor(
    readonly code: PiBoundaryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PiCredentialBoundaryError";
  }
}

export function validatePiToken(input: unknown): PiTokenValidation {
  if (typeof input !== "string") {
    return { ok: false, reason: "required", message: "Enter an API token." };
  }
  if (TOKEN_CONTROL_CHARACTERS.test(input)) {
    return {
      ok: false,
      reason: "control-character",
      message: "The API token must not contain line breaks or control characters.",
    };
  }

  const token = input.trim();
  if (!token) return { ok: false, reason: "required", message: "Enter an API token." };
  if (token.length > MAX_TOKEN_LENGTH) {
    return {
      ok: false,
      reason: "too-long",
      message: "The API token must be 8,192 characters or fewer.",
    };
  }
  if (token.startsWith("$") || token.startsWith("!")) {
    return {
      ok: false,
      reason: "expression-prefix",
      message: "Enter the literal token value, not a Pi credential expression.",
    };
  }
  return { ok: true, token };
}

/** Escape interpolation markers so an accepted token remains an opaque literal in Pi's store. */
function encodePiLiteralToken(token: string): string {
  return token.replaceAll("$", "$$$$");
}

interface ProviderCredentialState {
  source: PiCredentialSource;
  configured: boolean;
  safeForRefresh: boolean;
  storedCredentialType?: PiStoredCredentialType;
}

interface ReadStatusOptions {
  refreshProviderIds?: readonly string[];
  forcedFailedProviderIds?: readonly string[];
}

export class PiCredentialBoundary {
  private readonly runtime: PiCredentialRuntime;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly inspectStoredCredential: (providerId: string) => PiStoredCredentialSafety;
  private readonly isCredentialSynchronizationError: (error: unknown) => boolean;
  private readonly refreshTimeoutMs: number;

  constructor(dependencies: PiCredentialBoundaryDependencies) {
    this.runtime = dependencies.runtime;
    this.environment = dependencies.environment ?? process.env;
    this.inspectStoredCredential = dependencies.inspectStoredCredential;
    this.isCredentialSynchronizationError = dependencies.isCredentialSynchronizationError;
    this.refreshTimeoutMs = dependencies.refreshTimeoutMs ?? 15_000;
  }

  listProviders() {
    try {
      return listInstalledOneTokenProviders(this.runtime).map(({ id, name }) => ({ id, name }));
    } catch {
      return [];
    }
  }

  async readStatus(): Promise<PiConfigurationStatus> {
    return this.collectStatus();
  }

  async refresh(providerId?: string): Promise<PiConfigurationStatus> {
    if (providerId) this.requireSupportedProvider(providerId);
    const providers = providerId
      ? [providerId]
      : listInstalledOneTokenProviders(this.runtime).map((provider) => provider.id);
    return this.collectStatus({ refreshProviderIds: providers });
  }

  async saveCredential(
    providerId: string,
    tokenInput: unknown,
    options: { confirmReplace: boolean },
  ): Promise<{
    credentialCommitted: true;
    replacedStoredCredential: boolean;
    synchronizationSucceeded: boolean;
    status: PiConfigurationStatus;
  }> {
    const validation = validatePiToken(tokenInput);
    if (!validation.ok) {
      throw new PiCredentialBoundaryError("invalid-token", validation.message);
    }
    this.requireSupportedProvider(providerId);

    let credentials: readonly PiCredentialInfo[];
    try {
      credentials = await this.runtime.listCredentials();
    } catch {
      throw new PiCredentialBoundaryError(
        "credential-save-failed",
        "The Pi credential could not be saved. Try again.",
      );
    }
    const replacing = credentials.some((credential) => credential.providerId === providerId);
    if (replacing && !options.confirmReplace) {
      throw new PiCredentialBoundaryError(
        "replacement-confirmation-required",
        "Confirm replacement of the existing Pi-stored credential.",
      );
    }

    let synchronizationSucceeded = true;
    let promptCount = 0;
    try {
      await this.runtime.login(providerId, "api_key", {
        prompt: async (prompt) => {
          promptCount += 1;
          if (promptCount !== 1 || (prompt.type !== "secret" && prompt.type !== "text")) {
            throw new PiCredentialBoundaryError(
              "credential-save-failed",
              "This Pi provider cannot be configured with the one-token form.",
            );
          }
          return encodePiLiteralToken(validation.token);
        },
        notify() {
          // The reviewed one-token path has no browser or device event to expose.
        },
      });
    } catch (error) {
      if (this.isCredentialSynchronizationError(error)) {
        synchronizationSucceeded = false;
      } else if (error instanceof PiCredentialBoundaryError) {
        throw error;
      } else {
        throw new PiCredentialBoundaryError(
          "credential-save-failed",
          "The Pi credential could not be saved. Try again.",
        );
      }
    }

    const status = await this.collectStatus(
      synchronizationSucceeded
        ? { refreshProviderIds: [providerId] }
        : { forcedFailedProviderIds: [providerId] },
    );
    return {
      credentialCommitted: true,
      replacedStoredCredential: replacing,
      synchronizationSucceeded:
        synchronizationSucceeded && status.catalog.kind !== "discovery-failed",
      status,
    };
  }

  async removeStoredCredential(
    providerId: string,
    options: { confirmRemove: boolean },
  ): Promise<{
    credentialRemoved: boolean;
    synchronizationSucceeded: boolean;
    status: PiConfigurationStatus;
  }> {
    this.requireSupportedProvider(providerId);
    let credentials: readonly PiCredentialInfo[];
    try {
      credentials = await this.runtime.listCredentials();
    } catch {
      throw new PiCredentialBoundaryError(
        "credential-remove-failed",
        "The stored Pi credential could not be removed. Try again.",
      );
    }
    const hasStoredCredential = credentials.some(
      (credential) => credential.providerId === providerId,
    );
    if (!hasStoredCredential) {
      return {
        credentialRemoved: false,
        synchronizationSucceeded: true,
        status: await this.collectStatus(),
      };
    }
    if (!options.confirmRemove) {
      throw new PiCredentialBoundaryError(
        "removal-confirmation-required",
        "Confirm removal of the provider-wide Pi-stored credential.",
      );
    }

    let synchronizationSucceeded = true;
    try {
      await this.runtime.logout(providerId);
    } catch (error) {
      if (this.isCredentialSynchronizationError(error)) {
        synchronizationSucceeded = false;
      } else {
        throw new PiCredentialBoundaryError(
          "credential-remove-failed",
          "The stored Pi credential could not be removed. Try again.",
        );
      }
    }
    const status = await this.collectStatus(
      synchronizationSucceeded
        ? { refreshProviderIds: [providerId] }
        : { forcedFailedProviderIds: [providerId] },
    );
    return {
      credentialRemoved: true,
      synchronizationSucceeded:
        synchronizationSucceeded && status.catalog.kind !== "discovery-failed",
      status,
    };
  }

  private requireSupportedProvider(providerId: string): void {
    let supported = false;
    try {
      supported = listInstalledOneTokenProviders(this.runtime).some(
        (provider) => provider.id === providerId,
      );
    } catch {
      // A catalog failure is intentionally indistinguishable from an unsupported provider here.
    }
    if (!supported) {
      throw new PiCredentialBoundaryError(
        "unsupported-provider",
        "This Pi provider is not supported by the one-token form.",
      );
    }
  }

  private credentialState(
    providerId: string,
    stored: ReadonlyMap<string, PiCredentialInfo>,
  ): ProviderCredentialState {
    const storedCredential = stored.get(providerId);
    if (storedCredential) {
      let safety: PiStoredCredentialSafety = "unreadable";
      try {
        safety = this.inspectStoredCredential(providerId);
      } catch {
        // Fail closed if credential metadata cannot be inspected without resolving it.
      }
      return {
        source: "stored",
        configured: true,
        safeForRefresh: safety === "literal" || safety === "oauth",
        storedCredentialType: storedCredential.type,
      };
    }

    const reviewed = getReviewedProvider(providerId);
    if (
      reviewed?.environmentKeys.some((key) => {
        const value = this.environment[key];
        return typeof value === "string" && value.length > 0;
      })
    ) {
      return { source: "environment", configured: true, safeForRefresh: true };
    }

    try {
      const auth = this.runtime.getProviderAuthStatus(providerId);
      if (auth.configured) {
        if (auth.source === "environment") {
          return { source: "environment", configured: true, safeForRefresh: true };
        }
        return {
          source: "external",
          configured: true,
          safeForRefresh: auth.source !== "models_json_command",
        };
      }
    } catch {
      return { source: "none", configured: false, safeForRefresh: false };
    }
    return { source: "none", configured: false, safeForRefresh: false };
  }

  private async collectStatus(options: ReadStatusOptions = {}): Promise<PiConfigurationStatus> {
    let installed: ReturnType<typeof listInstalledOneTokenProviders> = [];
    let discoveryInfrastructureFailed = false;
    try {
      installed = listInstalledOneTokenProviders(this.runtime);
    } catch {
      discoveryInfrastructureFailed = true;
    }
    const failedProviders = new Set(options.forcedFailedProviderIds ?? []);
    let credentials: readonly PiCredentialInfo[] = [];
    let credentialReadFailed = false;
    try {
      credentials = await this.runtime.listCredentials();
    } catch {
      credentialReadFailed = true;
      for (const provider of installed) failedProviders.add(provider.id);
    }
    const stored = new Map(credentials.map((credential) => [credential.providerId, credential]));
    const states = new Map<string, ProviderCredentialState>();
    for (const provider of installed) {
      const state = this.credentialState(provider.id, stored);
      states.set(provider.id, state);
      if (state.configured && !state.safeForRefresh) {
        failedProviders.add(provider.id);
      }
    }

    const requestedRefresh = (options.refreshProviderIds ?? []).filter((providerId) => {
      const state = states.get(providerId);
      return state?.configured && state.safeForRefresh && !failedProviders.has(providerId);
    });
    if (requestedRefresh.length > 0) {
      try {
        const refresh = await this.runtime.refresh({
          providers: requestedRefresh,
          allowNetwork: true,
          force: true,
          signal: AbortSignal.timeout(this.refreshTimeoutMs),
        });
        for (const providerId of refresh.errors.keys()) {
          if (states.has(providerId)) failedProviders.add(providerId);
        }
        if (refresh.aborted) {
          for (const providerId of requestedRefresh) failedProviders.add(providerId);
        }
      } catch {
        for (const providerId of requestedRefresh) failedProviders.add(providerId);
      }
    }

    if (credentialReadFailed) {
      for (const provider of installed) {
        if (states.get(provider.id)?.configured) failedProviders.add(provider.id);
      }
    }
    const configured = new Set(
      [...states].filter(([, state]) => state.configured).map(([providerId]) => providerId),
    );
    const availableModels: PiSdkModel[] = [];
    await Promise.all(
      [...configured].map(async (providerId) => {
        const state = states.get(providerId);
        if (!state?.safeForRefresh || failedProviders.has(providerId)) return;
        try {
          const providerModels = await this.runtime.getAvailable(providerId);
          availableModels.push(...providerModels.filter((model) => model.provider === providerId));
        } catch {
          failedProviders.add(providerId);
        }
      }),
    );
    let models: PiModelDescriptor[] = [];
    try {
      models = listEligiblePiModels(
        {
          getProviders: () => this.runtime.getProviders(),
          getProvider: (providerId) => this.runtime.getProvider(providerId),
          getModels: (providerId) =>
            providerId
              ? availableModels.filter((model) => model.provider === providerId)
              : availableModels,
        },
        configured,
        failedProviders,
      );
    } catch {
      discoveryInfrastructureFailed = true;
      for (const providerId of configured) failedProviders.add(providerId);
    }
    const modelCounts = new Map<string, number>();
    for (const model of models) {
      modelCounts.set(model.upstreamProvider, (modelCounts.get(model.upstreamProvider) ?? 0) + 1);
    }
    const providers = installed.map(({ id, name }) => {
      const state = states.get(id) ?? {
        source: "none" as const,
        configured: false,
        safeForRefresh: false,
      };
      const modelCount = modelCounts.get(id) ?? 0;
      const status: PiProviderStatus["status"] = failedProviders.has(id)
        ? "discovery-failed"
        : !state.configured
          ? "not-configured"
          : modelCount > 0
            ? "models-available"
            : "no-models";
      return {
        id,
        name,
        configured: state.configured,
        credentialSource: state.source,
        ...(state.storedCredentialType ? { storedCredentialType: state.storedCredentialType } : {}),
        modelCount,
        status,
      } satisfies PiProviderStatus;
    });

    const failed = [...failedProviders].filter((providerId) => states.has(providerId)).sort();
    let catalog: PiCatalogResult;
    if (failed.length > 0 || credentialReadFailed || discoveryInfrastructureFailed) {
      catalog = {
        kind: "discovery-failed",
        models,
        failedProviders: failed,
        message: DISCOVERY_FAILED_MESSAGE,
      };
    } else if (models.length > 0) {
      catalog = { kind: "models-available", models };
    } else {
      catalog = { kind: "no-models", models: [] };
    }
    return { providers, catalog, liveValidity: "not-verified" };
  }
}
