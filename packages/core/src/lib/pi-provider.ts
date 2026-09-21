import { join } from "node:path";
import { createLogger } from "../logger.js";
import type {
  PiCredentialMutationResult,
  PiDiscoveredModel,
  PiProviderStatus,
  PiSettingsStatus,
} from "@rome/api-types/pi-provider";
import { PI_PROVIDER_CATALOG } from "@rome/api-types/pi-provider";

// User-visible labels are reviewed with the one-token allowlist rather than inherited from Pi.
export const PI_PROVIDER_ALLOWLIST = PI_PROVIDER_CATALOG;

const ALLOWED = new Map<string, string>(PI_PROVIDER_ALLOWLIST);
const EXTERNAL_SOURCE = /^[A-Z][A-Z0-9_]*$/;
const CACHE_MS = 8_000;
const STATUS_TIMEOUT_MS = 15_000;
const log = createLogger("pi-settings");

interface RuntimeModel {
  id: string;
  name: string;
  provider: string;
  api: string;
  input: readonly ("text" | "image")[];
  reasoning: boolean;
}

export interface PiModelRuntime {
  getProviders(): readonly { id: string; name: string }[];
  listCredentials(options?: {
    signal?: AbortSignal;
  }): Promise<readonly { providerId: string; type: "api_key" | "oauth" }[]>;
  checkAuth(
    providerId: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ source?: string; type: "api_key" | "oauth" } | undefined>;
  getAvailable(
    providerId?: string,
    options?: { signal?: AbortSignal },
  ): Promise<readonly RuntimeModel[]>;
  login(
    providerId: string,
    type: "api_key",
    interaction: {
      signal?: AbortSignal;
      prompt(prompt: { type: string }): Promise<string>;
      notify(event: unknown): void;
    },
  ): Promise<unknown>;
  logout(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
  refresh(options?: {
    allowNetwork?: boolean;
    providers?: readonly string[];
    signal?: AbortSignal;
    force?: boolean;
  }): Promise<{ errors: ReadonlyMap<string, unknown>; aborted?: boolean }>;
}

interface RuntimeHandle {
  runtime: PiModelRuntime;
  dispose(): void | Promise<void>;
}

export type PiRuntimeFactory = () => Promise<RuntimeHandle>;

export class PiSettingsError extends Error {
  constructor(
    readonly code:
      | "invalid-provider"
      | "invalid-token"
      | "replace-required"
      | "unsupported-provider",
    message: string,
  ) {
    super(message);
  }
}

export function validatePiToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 8_192 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new PiSettingsError("invalid-token", "Enter a valid literal API token.");
  }
  const token = value.trim();
  if (!token || token.includes("$") || token.startsWith("!")) {
    throw new PiSettingsError(
      "invalid-token",
      "Enter a literal API token; indirections are not supported.",
    );
  }
  return token;
}

function assertProvider(providerId: string): void {
  if (!ALLOWED.has(providerId)) {
    throw new PiSettingsError("invalid-provider", "Select a supported Pi provider.");
  }
}

export function qualifyPiModel(providerId: string, modelId: string): string {
  return `${encodeURIComponent(providerId)}/${encodeURIComponent(modelId)}`;
}

function isCredentialSynchronizationError(error: unknown): boolean {
  // Keep the SDK import lazy even on an error path. Pi's exported error has a
  // stable name, while importing it here could mask the original login/logout
  // failure if module loading itself failed.
  return error instanceof Error && error.name === "CredentialSynchronizationError";
}

export function piRuntimePaths(agentDir: string) {
  return {
    authPath: join(agentDir, "auth.json"),
    // This Rome-owned, intentionally absent config path avoids loading Pi's
    // user models.json while enabling Pi's persistent catalog store.
    modelsPath: join(agentDir, "rome-models.json"),
    modelsStorePath: join(agentDir, "models-cache.json"),
  };
}

async function defaultRuntimeFactory(): Promise<RuntimeHandle> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const runtime = await sdk.ModelRuntime.create({
    ...piRuntimePaths(sdk.getAgentDir()),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  return {
    runtime,
    async dispose() {
      // ModelRuntime 0.86.1 exposes no disposable resource. Keep the scoped
      // lifecycle explicit so a future SDK disposer is always honored.
      const disposable = runtime as unknown as {
        dispose?: () => void | Promise<void>;
        [Symbol.asyncDispose]?: () => Promise<void>;
      };
      const asyncDispose = disposable[Symbol.asyncDispose];
      if (asyncDispose) await asyncDispose.call(disposable);
      else await disposable.dispose?.call(disposable);
    },
  };
}

export class PiSettingsService {
  private cached: { expiresAt: number; value: PiSettingsStatus } | null = null;
  private inFlight: { generation: number; promise: Promise<PiSettingsStatus> } | null = null;
  private cacheGeneration = 0;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly createRuntime: PiRuntimeFactory = defaultRuntimeFactory,
    private readonly statusTimeoutMs = STATUS_TIMEOUT_MS,
  ) {}

  private invalidateCache(): number {
    this.cacheGeneration += 1;
    this.cached = null;
    return this.cacheGeneration;
  }

  private cacheStatus(generation: number, value: PiSettingsStatus): void {
    if (this.cacheGeneration === generation) {
      this.cached = { value, expiresAt: Date.now() + CACHE_MS };
    }
  }

  private async withCredentialMutation<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async useRuntime<T>(fn: (runtime: PiModelRuntime) => Promise<T>): Promise<T> {
    const pendingHandle = this.createRuntime();
    let handle: RuntimeHandle;
    try {
      handle = await this.withTimeout(async () => await pendingHandle, true);
    } catch (error) {
      // A factory cannot accept AbortSignal. If it finishes after our deadline,
      // still dispose its runtime without holding a credential mutation hostage.
      void pendingHandle.then(
        (lateHandle) => Promise.resolve(lateHandle.dispose()).catch(() => {}),
        () => {},
      );
      throw error;
    }
    try {
      return await fn(handle.runtime);
    } finally {
      await this.withTimeout(async () => await handle.dispose(), true);
    }
  }

  private async readStatus(
    runtime: PiModelRuntime,
    signal?: AbortSignal,
  ): Promise<PiSettingsStatus> {
    const [credentials, providerEntries] = await Promise.all([
      runtime.listCredentials({ signal }),
      Promise.resolve(runtime.getProviders()),
    ]);
    const stored = new Map(credentials.map((item) => [item.providerId, item.type]));
    const known = new Map(providerEntries.map((provider) => [provider.id, provider.name]));
    const providers: PiProviderStatus[] = [];
    const models: PiDiscoveredModel[] = [];
    const failed: string[] = [];

    for (const [id, reviewedName] of PI_PROVIDER_ALLOWLIST) {
      if (!known.has(id)) continue;
      let auth: Awaited<ReturnType<PiModelRuntime["checkAuth"]>>;
      try {
        auth = await runtime.checkAuth(id, { signal });
      } catch (error) {
        log.debug("Pi authentication probe failed", {
          providerId: id,
          errorType: error instanceof Error ? error.name : typeof error,
        });
        failed.push(id);
      }
      const storedType = stored.get(id);
      const source = storedType ? "stored" : auth ? "environment" : "none";
      let available: readonly RuntimeModel[] = [];
      if (source !== "none") {
        try {
          available = await runtime.getAvailable(id, { signal });
        } catch (error) {
          log.debug("Pi model availability probe failed", {
            providerId: id,
            errorType: error instanceof Error ? error.name : typeof error,
          });
          if (!failed.includes(id)) failed.push(id);
        }
      }
      for (const model of available) {
        models.push({
          qualifiedModelId: qualifyPiModel(id, model.id),
          providerId: id,
          providerName: reviewedName,
          modelId: model.id,
          name: model.name,
          api: model.api,
          input: [...model.input],
          reasoning: model.reasoning,
        });
      }
      providers.push({
        id,
        name: reviewedName,
        configured: source !== "none",
        credentialSource: source,
        ...(storedType ? { storedCredentialType: storedType } : {}),
        ...(source === "environment" && auth?.source
          ? { externalSource: EXTERNAL_SOURCE.test(auth.source) ? auth.source : "external" }
          : {}),
        modelCount: available.length,
      });
    }
    models.sort((a, b) => a.qualifiedModelId.localeCompare(b.qualifiedModelId));
    return {
      providers,
      models,
      catalogStatus: failed.length
        ? "discovery-failed"
        : models.length
          ? "models-available"
          : "no-models",
      liveValidity: "not-verified",
      discoveryFailedProviders: failed,
    };
  }

  private async withTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    rejectOnTimeout = false,
  ): Promise<T> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        if (rejectOnTimeout) reject(new Error("Pi settings operation timed out."));
      }, this.statusTimeoutMs);
    });
    try {
      const operation = Promise.resolve().then(() => fn(controller.signal));
      return await (rejectOnTimeout ? Promise.race([operation, timedOut]) : operation);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async readStatusWithTimeout(runtime: PiModelRuntime): Promise<PiSettingsStatus> {
    return await this.withTimeout((signal) => this.readStatus(runtime, signal));
  }

  status(options: { bypassCache?: boolean } = {}): Promise<PiSettingsStatus> {
    if (!options.bypassCache && this.cached && this.cached.expiresAt > Date.now()) {
      return Promise.resolve(this.cached.value);
    }
    const generation = this.cacheGeneration;
    if (!options.bypassCache && this.inFlight?.generation === generation) {
      return this.inFlight.promise;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.statusTimeoutMs);
    const promise = this.useRuntime((runtime) => this.readStatus(runtime, controller.signal))
      .then((value) => {
        this.cacheStatus(generation, value);
        return value;
      })
      .finally(() => clearTimeout(timeout));
    if (!options.bypassCache) {
      const inFlight = { generation, promise };
      this.inFlight = inFlight;
      void promise.then(
        () => {
          if (this.inFlight === inFlight) this.inFlight = null;
        },
        () => {
          if (this.inFlight === inFlight) this.inFlight = null;
        },
      );
    }
    return promise;
  }

  async saveCredential(input: {
    providerId: string;
    token: unknown;
    confirmReplace?: boolean;
  }): Promise<PiCredentialMutationResult> {
    assertProvider(input.providerId);
    validatePiToken(input.token);
    return await this.withCredentialMutation(() => this.saveCredentialUnlocked(input));
  }

  private async saveCredentialUnlocked(input: {
    providerId: string;
    token: unknown;
    confirmReplace?: boolean;
  }): Promise<PiCredentialMutationResult> {
    assertProvider(input.providerId);
    const token = validatePiToken(input.token);
    this.invalidateCache();
    let synchronized = true;
    let status: PiSettingsStatus | undefined;
    await this.useRuntime(async (runtime) => {
      if (!runtime.getProviders().some((provider) => provider.id === input.providerId)) {
        throw new PiSettingsError(
          "unsupported-provider",
          "This provider is not available in the installed Pi SDK.",
        );
      }
      const stored = await this.withTimeout((signal) => runtime.listCredentials({ signal }), true);
      if (stored.some((item) => item.providerId === input.providerId) && !input.confirmReplace) {
        throw new PiSettingsError("replace-required", "Confirm replacing the stored credential.");
      }
      let prompts = 0;
      try {
        await this.withTimeout(
          (signal) =>
            runtime.login(input.providerId, "api_key", {
              signal,
              async prompt(prompt) {
                prompts += 1;
                if (prompts > 1 || prompt.type !== "secret") {
                  throw new PiSettingsError(
                    "unsupported-provider",
                    "This provider needs unsupported setup fields.",
                  );
                }
                return token;
              },
              notify() {},
            }),
          true,
        );
      } catch (error) {
        if (isCredentialSynchronizationError(error)) {
          synchronized = false;
        } else {
          throw error;
        }
      }
      let catalogFailed = false;
      try {
        const refreshed = await this.withTimeout(
          (signal) =>
            runtime.refresh({
              allowNetwork: true,
              providers: [input.providerId],
              signal,
              force: true,
            }),
          true,
        );
        catalogFailed = refreshed.aborted === true || refreshed.errors.has(input.providerId);
      } catch {
        catalogFailed = true;
      }
      status = await this.readStatusWithTimeout(runtime);
      if (catalogFailed) {
        status = {
          ...status,
          catalogStatus: "discovery-failed",
          discoveryFailedProviders: [
            ...new Set([...status.discoveryFailedProviders, input.providerId]),
          ],
        };
      }
    });
    if (!status) throw new Error("Pi credential status was unavailable after save.");
    this.cacheStatus(this.invalidateCache(), status);
    return {
      credentialPersisted: true,
      synchronizationSucceeded: synchronized,
      status,
    };
  }

  async removeCredential(providerId: string): Promise<PiSettingsStatus> {
    assertProvider(providerId);
    return await this.withCredentialMutation(() => this.removeCredentialUnlocked(providerId));
  }

  private async removeCredentialUnlocked(providerId: string): Promise<PiSettingsStatus> {
    this.invalidateCache();
    await this.useRuntime(async (runtime) => {
      const stored = await this.withTimeout((signal) => runtime.listCredentials({ signal }), true);
      if (!stored.some((item) => item.providerId === providerId)) return;
      try {
        await this.withTimeout((signal) => runtime.logout(providerId, { signal }), true);
      } catch (error) {
        if (!isCredentialSynchronizationError(error)) throw error;
      }
    });
    this.invalidateCache();
    return this.status({ bypassCache: true });
  }

  async refreshProvider(providerId: string): Promise<PiSettingsStatus> {
    assertProvider(providerId);
    return await this.withCredentialMutation(() => this.refreshProviderUnlocked(providerId));
  }

  private async refreshProviderUnlocked(providerId: string): Promise<PiSettingsStatus> {
    this.invalidateCache();
    let refreshFailed = false;
    await this.useRuntime(async (runtime) => {
      const result = await this.withTimeout(
        (signal) =>
          runtime.refresh({
            allowNetwork: true,
            providers: [providerId],
            signal,
            force: true,
          }),
        true,
      );
      refreshFailed = result.aborted === true || result.errors.has(providerId);
    });
    const cacheGeneration = this.invalidateCache();
    const status = await this.status({ bypassCache: true });
    if (!refreshFailed) return status;
    const failed = [...new Set([...status.discoveryFailedProviders, providerId])];
    const result: PiSettingsStatus = {
      ...status,
      catalogStatus: "discovery-failed",
      discoveryFailedProviders: failed,
    };
    this.cacheStatus(cacheGeneration, result);
    return result;
  }
}

let singleton: PiSettingsService | undefined;
export function getPiSettingsService(): PiSettingsService {
  singleton ??= new PiSettingsService();
  return singleton;
}
