import { chmod, lstat, readFile } from "node:fs/promises";
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

type StoredCredentialLiteralCheck = (providerId: string) => Promise<boolean>;
type AuthFilePermissionHardener = () => Promise<void>;

interface RuntimeHandle {
  runtime: PiModelRuntime;
  dispose(): void | Promise<void>;
  isStoredCredentialLiteral?: StoredCredentialLiteralCheck;
  hardenAuthFilePermissions?: AuthFilePermissionHardener;
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

class PiSettingsTimeoutError extends Error {
  constructor() {
    super("Pi settings operation timed out.");
    this.name = "PiSettingsTimeoutError";
  }
}

export function validatePiToken(value: unknown): string {
  if (typeof value !== "string") {
    throw new PiSettingsError("invalid-token", "Enter a valid literal API token.");
  }
  const token = value.trim();
  if (!token || token.length > 8_192 || /[\u0000-\u001f\u007f-\u009f]/u.test(token)) {
    throw new PiSettingsError("invalid-token", "Enter a valid literal API token.");
  }
  if (token.includes("$") || token.startsWith("!")) {
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

function isPiSettingsTimeoutError(error: unknown): error is PiSettingsTimeoutError {
  return error instanceof PiSettingsTimeoutError;
}

export function piRuntimePaths(agentDir: string) {
  return {
    authPath: join(agentDir, "auth.json"),
    // Do not load a model config: Pi composes any existing modelsPath into its
    // provider registry. Discovery is intentionally limited to the reviewed
    // built-in catalog, and its short-lived Rome cache is sufficient here.
    modelsPath: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function hardenPiAuthFilePermissions(authPath: string): Promise<void> {
  try {
    const metadata = await lstat(authPath);
    if (!metadata.isFile()) {
      throw new Error("Pi credential storage is not a regular file.");
    }
    if ((metadata.mode & 0o077) !== 0) {
      await chmod(authPath, 0o600);
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function isLiteralStoredCredential(authPath: string, providerId: string): Promise<boolean> {
  try {
    const auth = JSON.parse(await readFile(authPath, "utf8")) as unknown;
    if (!isRecord(auth)) return false;
    const credential = auth[providerId];
    if (!isRecord(credential)) return false;
    if (credential.type === "oauth") return true;
    if (credential.type !== "api_key" || typeof credential.key !== "string") return false;
    // Pi resolves `$` anywhere and a leading `!` as a command. Do not let its
    // auth probe interpret either expression from the shared Pi auth file.
    return !credential.key.includes("$") && !credential.key.startsWith("!");
  } catch {
    // An unreadable or concurrently-written auth file is metadata-only until
    // Pi can safely report it on a later request.
    return false;
  }
}

async function defaultRuntimeFactory(): Promise<RuntimeHandle> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const paths = piRuntimePaths(sdk.getAgentDir());
  const runtime = await sdk.ModelRuntime.create({
    ...paths,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  return {
    runtime,
    isStoredCredentialLiteral: (providerId) =>
      isLiteralStoredCredential(paths.authPath, providerId),
    hardenAuthFilePermissions: () => hardenPiAuthFilePermissions(paths.authPath),
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

  private async useRuntime<T>(
    fn: (
      runtime: PiModelRuntime,
      isStoredCredentialLiteral?: StoredCredentialLiteralCheck,
      hardenAuthFilePermissions?: AuthFilePermissionHardener,
    ) => Promise<T>,
  ): Promise<T> {
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
      return await fn(
        handle.runtime,
        handle.isStoredCredentialLiteral,
        handle.hardenAuthFilePermissions,
      );
    } finally {
      await this.withTimeout(async () => await handle.dispose(), true).catch((error) => {
        log.debug("Pi runtime disposal failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      });
    }
  }

  private async readStatus(
    runtime: PiModelRuntime,
    signal?: AbortSignal,
    isStoredCredentialLiteral?: StoredCredentialLiteralCheck,
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
      const storedType = stored.get(id);
      const literalStoredCredential =
        storedType !== undefined && (await isStoredCredentialLiteral?.(id)) === true;
      let auth: Awaited<ReturnType<PiModelRuntime["checkAuth"]>>;
      // Pi resolves stored !command and $template API keys while probing auth.
      // Status only resolves an inspected literal; dynamic existing Pi auth is
      // surfaced as redacted metadata without evaluating its expression.
      if (!storedType) {
        try {
          auth = await runtime.checkAuth(id, { signal });
        } catch (error) {
          log.debug("Pi authentication probe failed", {
            providerId: id,
            errorType: error instanceof Error ? error.name : typeof error,
          });
          failed.push(id);
        }
      }
      const source = storedType ? "stored" : auth ? "environment" : "none";
      let available: readonly RuntimeModel[] = [];
      if (source === "environment" || literalStoredCredential) {
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
        if (rejectOnTimeout) reject(new PiSettingsTimeoutError());
      }, this.statusTimeoutMs);
    });
    try {
      const operation = Promise.resolve().then(() => fn(controller.signal));
      return await (rejectOnTimeout ? Promise.race([operation, timedOut]) : operation);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async readStatusWithTimeout(
    runtime: PiModelRuntime,
    isStoredCredentialLiteral?: StoredCredentialLiteralCheck,
  ): Promise<PiSettingsStatus> {
    return await this.withTimeout(
      (signal) => this.readStatus(runtime, signal, isStoredCredentialLiteral),
      true,
    );
  }

  status(options: { bypassCache?: boolean } = {}): Promise<PiSettingsStatus> {
    if (!options.bypassCache && this.cached && this.cached.expiresAt > Date.now()) {
      return Promise.resolve(this.cached.value);
    }
    const generation = this.cacheGeneration;
    if (!options.bypassCache && this.inFlight?.generation === generation) {
      return this.inFlight.promise;
    }
    const promise = this.withTimeout(
      (signal) =>
        this.useRuntime((runtime, isStoredCredentialLiteral) =>
          this.readStatus(runtime, signal, isStoredCredentialLiteral),
        ),
      true,
    ).then((value) => {
      this.cacheStatus(generation, value);
      return value;
    });
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
    let timedOutAfterLogin: PiSettingsTimeoutError | undefined;
    let status: PiSettingsStatus | undefined;
    await this.useRuntime(async (runtime, isStoredCredentialLiteral, hardenAuthFilePermissions) => {
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
      await hardenAuthFilePermissions?.();
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
        } else if (isPiSettingsTimeoutError(error)) {
          // Pi can commit auth.json before completing its local catalog sync.
          // Reconcile the store before presenting a timeout as a failed save.
          const credentials = await this.withTimeout(
            (signal) => runtime.listCredentials({ signal }),
            true,
          );
          if (!credentials.some((credential) => credential.providerId === input.providerId)) {
            throw error;
          }
          timedOutAfterLogin = error;
          synchronized = false;
        } else {
          throw error;
        }
      }
      // Pi can create auth.json during login, so verify the file it actually
      // wrote as well as an existing file before handing the token to Pi.
      await hardenAuthFilePermissions?.();
      const literalStoredCredential =
        (await isStoredCredentialLiteral?.(input.providerId)) === true;
      let catalogFailed = false;
      if (literalStoredCredential) {
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
      }
      status = await this.readStatusWithTimeout(runtime, isStoredCredentialLiteral);
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
    if (
      timedOutAfterLogin &&
      status.providers.find((provider) => provider.id === input.providerId)?.credentialSource !==
        "stored"
    ) {
      throw timedOutAfterLogin;
    }
    const credentialPersisted =
      status.providers.find((provider) => provider.id === input.providerId)?.credentialSource ===
      "stored";
    this.cacheStatus(this.invalidateCache(), status);
    return {
      credentialPersisted,
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
      if (stored.some((item) => item.providerId === providerId)) {
        try {
          await this.withTimeout((signal) => runtime.logout(providerId, { signal }), true);
        } catch (error) {
          if (isPiSettingsTimeoutError(error)) {
            // Logout can commit auth.json before Pi completes local catalog
            // synchronization. Treat a confirmed removal as partial success.
            const credentials = await this.withTimeout(
              (signal) => runtime.listCredentials({ signal }),
              true,
            );
            if (credentials.some((credential) => credential.providerId === providerId)) {
              throw error;
            }
          } else if (!isCredentialSynchronizationError(error)) {
            throw error;
          }
        }
      }
    });
    this.invalidateCache();
    // Pi can retain credential state inside the mutation runtime. Read the
    // persisted auth file through a fresh runtime for the public response.
    return this.status({ bypassCache: true });
  }

  async refreshProvider(providerId: string): Promise<PiSettingsStatus> {
    assertProvider(providerId);
    return await this.withCredentialMutation(() => this.refreshProviderUnlocked(providerId));
  }

  private async refreshProviderUnlocked(providerId: string): Promise<PiSettingsStatus> {
    this.invalidateCache();
    let refreshFailed = false;
    let status: PiSettingsStatus | undefined;
    await this.useRuntime(async (runtime, isStoredCredentialLiteral) => {
      const stored = await this.withTimeout((signal) => runtime.listCredentials({ signal }), true);
      const hasStoredCredential = stored.some((credential) => credential.providerId === providerId);
      const literalStoredCredential = (await isStoredCredentialLiteral?.(providerId)) === true;
      // Never let an explicit refresh resolve a pre-existing Pi !command or
      // $template credential. Literal Pi credentials remain refreshable.
      if (!hasStoredCredential || literalStoredCredential) {
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
      }
      // Pi's catalog store is scoped to this runtime; read its refreshed
      // models before disposal instead of constructing a second empty runtime.
      status = await this.readStatusWithTimeout(runtime, isStoredCredentialLiteral);
    });
    if (!status) throw new Error("Pi credential status was unavailable after refresh.");
    const cacheGeneration = this.invalidateCache();
    if (!refreshFailed) {
      this.cacheStatus(cacheGeneration, status);
      return status;
    }
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
