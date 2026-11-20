import { join } from "node:path";
import { platform as osPlatform } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { cloudOrigin, isRecord, validId } from "@rome-os/node-core";
import {
  AuditStore,
  connectHost,
  connectLimitedHost,
  createFileCredentialStore,
  defaultDeviceName,
  loginDeviceCode,
  type AuditResult,
  type AuditSummary,
  type CredentialStore,
  type DeviceAuthorizationPrompt,
  type DeviceSession,
  type HostCredential,
  type HostEvent,
} from "@rome-os/node-core/host";
import { readPrivateJson, writePrivateJson } from "@rome-os/node-core/storage";
import { CLI_AUDIT_HINT, cliAuditPath } from "../audit.js";

const DEVICE_TOKEN_PATTERN = /^(?:romedev|romemob)_[A-Za-z0-9_-]{43}$/;
const AUDIT_POLL_MS = 1500;

export type HostPhase =
  | "unconfigured"
  | "authorizing"
  | "connecting"
  | "online"
  | "retrying"
  | "disconnected"
  | "revoked"
  | "superseded"
  | "error";

export interface PendingAuthorization {
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresAt: number;
}

export interface WebHostConfig {
  cloudUrl: string;
  name: string;
  autoConnect: boolean;
  executionEnabled: boolean;
}

export interface HostSnapshot {
  phase: HostPhase;
  since: number;
  configured: boolean;
  executionEnabled: boolean;
  autoConnect: boolean;
  cloudUrl: string;
  deviceName: string;
  deviceId: string | null;
  platform: string;
  version: string | null;
  pendingAuth: PendingAuthorization | null;
  lastError: string | null;
  audit: {
    summary: AuditSummary;
    counts: Record<AuditResult | "all", number> | null;
  };
}

export type HostControllerEvent =
  | { type: "status"; snapshot: HostSnapshot }
  | { type: "audit"; records: number };

export interface HostControllerDeps {
  connectHost?: typeof connectHost;
  connectLimitedHost?: typeof connectLimitedHost;
  loginDeviceCode?: typeof loginDeviceCode;
  openAudit?: (path: string) => Promise<AuditStore>;
  now?: () => number;
}

export interface HostControllerOptions {
  configDirectory: string;
  cloudUrl?: string;
  explicitCloudUrl?: boolean;
  name?: string;
  explicitName?: boolean;
  version?: string;
  deps?: HostControllerDeps;
}

class CredentialInvalidError extends Error {
  constructor() {
    super("Stored device credential is no longer valid. Authorize this node again.");
  }
}

export class ControllerInputError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function validateDeviceName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 80 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ControllerInputError(
      "Device name must be 1 to 80 characters without control characters.",
    );
  }
  return trimmed;
}

function parseStoredCredential(value: unknown): HostCredential | null {
  if (!isRecord(value)) return null;
  if (typeof value.cloudUrl !== "string") return null;
  let origin: string;
  try {
    origin = cloudOrigin(value.cloudUrl);
  } catch {
    return null;
  }
  if (
    typeof value.token !== "string" ||
    !DEVICE_TOKEN_PATTERN.test(value.token) ||
    typeof value.deviceId !== "string" ||
    !validId(value.deviceId) ||
    typeof value.name !== "string"
  ) {
    return null;
  }
  return {
    cloudUrl: origin,
    token: value.token,
    deviceId: value.deviceId,
    name: value.name,
  };
}

function parseWebConfig(value: unknown, fallback: WebHostConfig): WebHostConfig {
  if (!isRecord(value)) return fallback;
  let nextCloud = fallback.cloudUrl;
  if (typeof value.cloudUrl === "string") {
    try {
      nextCloud = cloudOrigin(value.cloudUrl);
    } catch {
      nextCloud = fallback.cloudUrl;
    }
  }
  const nextName =
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    value.name.trim().length <= 80 &&
    !/[\u0000-\u001f\u007f]/.test(value.name)
      ? value.name.trim()
      : fallback.name;
  return {
    cloudUrl: nextCloud,
    name: nextName,
    autoConnect: typeof value.autoConnect === "boolean" ? value.autoConnect : fallback.autoConnect,
    executionEnabled:
      typeof value.executionEnabled === "boolean"
        ? value.executionEnabled
        : fallback.executionEnabled,
  };
}

export class HostController {
  private readonly configPath: string;
  private readonly credentials: CredentialStore<HostCredential>;
  private readonly doConnectHost: typeof connectHost;
  private readonly doConnectLimitedHost: typeof connectLimitedHost;
  private readonly doLoginDeviceCode: typeof loginDeviceCode;
  private readonly openAudit: (path: string) => Promise<AuditStore>;
  private readonly now: () => number;
  private readonly version: string | null;
  private readonly listeners = new Set<(event: HostControllerEvent) => void>();

  private auditStore: AuditStore | null = null;
  private config: WebHostConfig;
  private phase: HostPhase = "unconfigured";
  private since: number;
  private configured = false;
  private deviceId: string | null = null;
  private pendingAuth: PendingAuthorization | null = null;
  private lastError: string | null = null;

  private activeAbort: AbortController | null = null;
  private activeRun: Promise<void> | null = null;
  private authAbort: AbortController | null = null;
  private authRun: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private auditTimer: ReturnType<typeof setInterval> | null = null;
  private lastAuditRecords = -1;
  private lastAuditState = "";
  private disposed = false;

  constructor(private readonly options: HostControllerOptions) {
    this.now = options.deps?.now ?? (() => Date.now());
    this.since = this.now();
    this.version = options.version ?? null;
    this.configPath = join(options.configDirectory, "web-config.json");
    this.credentials = createFileCredentialStore<HostCredential>(
      join(options.configDirectory, "credential.json"),
    );
    this.doConnectHost = options.deps?.connectHost ?? connectHost;
    this.doConnectLimitedHost = options.deps?.connectLimitedHost ?? connectLimitedHost;
    this.doLoginDeviceCode = options.deps?.loginDeviceCode ?? loginDeviceCode;
    this.openAudit =
      options.deps?.openAudit ??
      ((path) =>
        AuditStore.open({
          path,
          entry: "cli",
          hint: CLI_AUDIT_HINT,
          version: options.version,
        }));
    this.config = {
      cloudUrl: cloudOrigin(options.cloudUrl ?? "https://romeos.cc"),
      name: validateDeviceName(options.name ?? defaultDeviceName()),
      autoConnect: true,
      executionEnabled: true,
    };
  }

  get audit(): AuditStore {
    if (!this.auditStore) throw new Error("HostController has not been started.");
    return this.auditStore;
  }

  subscribe(listener: (event: HostControllerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: HostControllerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures must never disrupt the host lifecycle.
      }
    }
  }

  private setPhase(next: HostPhase, error?: string | null): void {
    if (this.phase !== next) {
      this.phase = next;
      this.since = this.now();
    }
    if (error !== undefined) this.lastError = error;
    this.emit({ type: "status", snapshot: this.snapshot() });
  }

  private async saveConfig(): Promise<void> {
    await writePrivateJson(this.configPath, this.config);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  snapshot(): HostSnapshot {
    const summary: AuditSummary = this.auditStore
      ? this.auditStore.summary()
      : {
          path: cliAuditPath(this.options.configDirectory),
          status: { state: "unavailable", code: "io", message: "Audit log is not open." },
          bytes: 0,
          records: 0,
          requests: 0,
          oldestAt: null,
          newestAt: null,
          lastPrune: null,
          retention: { maxAgeDays: 30, maxBytes: 1024 * 1024 * 1024 },
        };
    let counts: Record<AuditResult | "all", number> | null = null;
    if (this.auditStore && summary.status.state === "ok") {
      try {
        counts = this.auditStore.resultCounts();
      } catch {
        counts = null;
      }
    }
    return {
      phase: this.phase,
      since: this.since,
      configured: this.configured,
      executionEnabled: this.config.executionEnabled,
      autoConnect: this.config.autoConnect,
      cloudUrl: this.config.cloudUrl,
      deviceName: this.config.name,
      deviceId: this.deviceId,
      platform: osPlatform(),
      version: this.version,
      pendingAuth: this.pendingAuth ? { ...this.pendingAuth } : null,
      lastError: this.lastError,
      audit: { summary, counts },
    };
  }

  async start(): Promise<void> {
    this.auditStore = await this.openAudit(cliAuditPath(this.options.configDirectory));
    const storedConfig = parseWebConfig(await readPrivateJson(this.configPath), this.config);
    this.config = {
      ...storedConfig,
      ...(this.options.explicitCloudUrl
        ? { cloudUrl: cloudOrigin(this.options.cloudUrl ?? "https://romeos.cc") }
        : {}),
      ...(this.options.explicitName && this.options.name
        ? { name: validateDeviceName(this.options.name) }
        : {}),
    };

    const storedCredential = parseStoredCredential(await this.credentials.load());
    if (storedCredential) {
      this.configured = true;
      this.deviceId = storedCredential.deviceId;
      this.config.cloudUrl = storedCredential.cloudUrl;
      this.config.name = storedCredential.name;
      if (this.config.autoConnect) {
        this.launchConnection(storedCredential);
      } else {
        this.setPhase("disconnected", null);
      }
    } else {
      this.configured = false;
      this.deviceId = null;
      this.setPhase("unconfigured", null);
    }

    const initialSummary = this.auditStore.summary();
    this.lastAuditRecords = initialSummary.records;
    this.lastAuditState = initialSummary.status.state;
    this.auditTimer = setInterval(() => {
      if (this.disposed || this.listeners.size === 0 || !this.auditStore) return;
      try {
        const next = this.auditStore.summary();
        if (next.records !== this.lastAuditRecords || next.status.state !== this.lastAuditState) {
          this.lastAuditRecords = next.records;
          this.lastAuditState = next.status.state;
          this.emit({ type: "audit", records: next.records });
          this.emit({ type: "status", snapshot: this.snapshot() });
        }
      } catch {
        // Observing audit log changes must never disrupt the host.
      }
    }, AUDIT_POLL_MS);
    this.auditTimer.unref();
  }

  private async stopActiveConnection(): Promise<void> {
    const controller = this.activeAbort;
    const run = this.activeRun;
    this.activeAbort = null;
    this.activeRun = null;
    if (controller) controller.abort();
    if (run) await run.catch(() => {});
  }

  private async stopActiveAuthorization(): Promise<void> {
    const controller = this.authAbort;
    const run = this.authRun;
    this.authAbort = null;
    this.authRun = null;
    this.pendingAuth = null;
    if (controller) controller.abort();
    if (run) await run.catch(() => {});
  }

  private launchConnection(credential: HostCredential): void {
    const controller = new AbortController();
    const { signal } = controller;
    this.activeAbort = controller;
    this.setPhase("connecting", null);

    const onEvent = (event: HostEvent) => {
      if (signal.aborted || this.activeAbort !== controller) return;
      if (event.type === "device") {
        this.deviceId = event.deviceId;
        this.config.name = event.name;
        this.emit({ type: "status", snapshot: this.snapshot() });
      } else if (event.type === "retrying") {
        this.setPhase("retrying");
      } else if (event.type === "connection") {
        if (
          event.status === "online" ||
          event.status === "connecting" ||
          event.status === "retrying" ||
          event.status === "revoked" ||
          event.status === "superseded"
        ) {
          this.setPhase(event.status, event.status === "online" ? null : undefined);
        }
      }
    };

    const rejectUnexpectedReauth = async (): Promise<DeviceSession> => {
      throw new CredentialInvalidError();
    };

    const baseOptions = {
      cloudUrl: credential.cloudUrl,
      name: credential.name,
      signal,
      credentials: this.credentials,
      authorize: rejectUnexpectedReauth,
      onEvent,
      audit: this.audit,
    };

    const run = (
      this.config.executionEnabled
        ? this.doConnectHost({ ...baseOptions, audit: this.audit })
        : this.doConnectLimitedHost(baseOptions)
    )
      .then(() => {
        if (this.activeAbort !== controller || signal.aborted) return;
        this.activeAbort = null;
        this.activeRun = null;
        if (this.phase !== "revoked" && this.phase !== "superseded") {
          this.setPhase(this.configured ? "disconnected" : "unconfigured");
        }
      })
      .catch((error: unknown) => {
        if (this.activeAbort !== controller || signal.aborted) return;
        this.activeAbort = null;
        this.activeRun = null;
        if (error instanceof CredentialInvalidError) {
          this.configured = false;
          this.deviceId = null;
          this.setPhase("revoked", error.message);
          return;
        }
        const message = error instanceof Error ? error.message : "Host connection failed.";
        if (this.phase === "revoked" || this.phase === "superseded") {
          this.lastError = message;
          this.emit({ type: "status", snapshot: this.snapshot() });
        } else {
          this.setPhase("error", message);
        }
      });

    this.activeRun = run;
  }

  async authorize(input?: { cloudUrl?: string; name?: string }): Promise<HostSnapshot> {
    return this.enqueue(async () => {
      let nextCloud = this.config.cloudUrl;
      if (input?.cloudUrl !== undefined) {
        try {
          nextCloud = cloudOrigin(input.cloudUrl);
        } catch (error) {
          throw new ControllerInputError(
            error instanceof Error ? error.message : "Invalid Cloud origin.",
          );
        }
      }
      const nextName =
        input?.name !== undefined ? validateDeviceName(input.name) : this.config.name;

      await this.stopActiveConnection();
      await this.stopActiveAuthorization();

      this.config.cloudUrl = nextCloud;
      this.config.name = nextName;
      await this.saveConfig();

      const controller = new AbortController();
      this.authAbort = controller;
      this.pendingAuth = null;
      this.setPhase("authorizing", null);

      let promptReady!: () => void;
      const firstPromptOrEnd = new Promise<void>((resolve) => {
        promptReady = resolve;
      });

      const run = this.doLoginDeviceCode(
        nextCloud,
        nextName,
        controller.signal,
        (prompt: DeviceAuthorizationPrompt) => {
          if (this.authAbort !== controller || controller.signal.aborted) return;
          this.pendingAuth = {
            verificationUri: prompt.verificationUri,
            verificationUriComplete: prompt.verificationUriComplete,
            userCode: prompt.userCode,
            expiresAt: this.now() + prompt.expiresIn * 1000,
          };
          this.emit({ type: "status", snapshot: this.snapshot() });
          promptReady();
        },
      )
        .then(async (session) => {
          if (this.authAbort !== controller || controller.signal.aborted) return;
          const credential: HostCredential = { ...session, name: nextName };
          await this.credentials.save(credential);
          this.authAbort = null;
          this.authRun = null;
          this.pendingAuth = null;
          this.configured = true;
          this.deviceId = credential.deviceId;
          this.config.cloudUrl = credential.cloudUrl;
          this.config.name = credential.name;
          this.config.autoConnect = true;
          await this.saveConfig();
          this.launchConnection(credential);
        })
        .catch((error: unknown) => {
          if (this.authAbort !== controller || controller.signal.aborted) return;
          this.authAbort = null;
          this.authRun = null;
          this.pendingAuth = null;
          const message = error instanceof Error ? error.message : "Device authorization failed.";
          this.setPhase("error", message);
        })
        .finally(() => {
          promptReady();
        });

      this.authRun = run;
      await Promise.race([firstPromptOrEnd, delay(15_000, undefined, { ref: false })]);
      return this.snapshot();
    });
  }

  async cancelAuthorization(): Promise<HostSnapshot> {
    return this.enqueue(async () => {
      await this.stopActiveAuthorization();
      if (this.phase === "authorizing") {
        this.setPhase(this.configured ? "disconnected" : "unconfigured", null);
      }
      return this.snapshot();
    });
  }

  async connect(): Promise<HostSnapshot> {
    return this.enqueue(async () => {
      await this.stopActiveAuthorization();
      await this.stopActiveConnection();
      const credential = parseStoredCredential(await this.credentials.load());
      if (!credential) {
        this.configured = false;
        this.deviceId = null;
        this.setPhase("unconfigured", null);
        throw new ControllerInputError("No device credential found. Authorize this node first.");
      }
      this.configured = true;
      this.deviceId = credential.deviceId;
      this.config.cloudUrl = credential.cloudUrl;
      this.config.name = credential.name;
      this.config.autoConnect = true;
      await this.saveConfig();
      this.launchConnection(credential);
      return this.snapshot();
    });
  }

  async disconnect(): Promise<HostSnapshot> {
    return this.enqueue(async () => {
      await this.stopActiveConnection();
      this.config.autoConnect = false;
      await this.saveConfig();
      if (this.phase !== "authorizing") {
        this.setPhase(this.configured ? "disconnected" : "unconfigured", null);
      }
      return this.snapshot();
    });
  }

  async setExecutionEnabled(enabled: boolean): Promise<HostSnapshot> {
    return this.enqueue(async () => {
      if (this.config.executionEnabled === enabled) return this.snapshot();
      this.config.executionEnabled = enabled;
      await this.saveConfig();
      const wasActive = this.activeAbort !== null;
      if (wasActive) {
        await this.stopActiveConnection();
        const credential = parseStoredCredential(await this.credentials.load());
        if (credential) {
          this.launchConnection(credential);
          return this.snapshot();
        }
      }
      this.emit({ type: "status", snapshot: this.snapshot() });
      return this.snapshot();
    });
  }

  async clearCredentials(): Promise<HostSnapshot> {
    return this.enqueue(async () => {
      await this.stopActiveAuthorization();
      await this.stopActiveConnection();
      await this.credentials.clear();
      this.configured = false;
      this.deviceId = null;
      this.config.autoConnect = true;
      await this.saveConfig();
      this.setPhase("unconfigured", null);
      return this.snapshot();
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.auditTimer) {
      clearInterval(this.auditTimer);
      this.auditTimer = null;
    }
    await Promise.race([
      Promise.all([this.stopActiveAuthorization(), this.stopActiveConnection()]),
      delay(3500, undefined, { ref: false }),
    ]);
    this.auditStore?.close();
    this.auditStore = null;
  }
}
