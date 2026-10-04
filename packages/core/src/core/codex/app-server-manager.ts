import { createLogger } from "../../logger.js";
import { getInstanceToken } from "../../lib/instance-identity.js";
import { getRomeCloudOrigin } from "../../lib/rome-cloud-origin.js";
import { CODEX_ENV_ALLOWLIST } from "./common.js";
import { codexAppServerConfigArgs, ROME_CREDITS_TOKEN_ENV } from "./rome-credits-provider.js";
import { AppServerClient, type AppServerClientOptions } from "./app-server-client.js";
import {
  Method,
  ServerRequestMethod,
  toThreadConfigurationOverrides,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
  type ThreadHistoryMode,
  type ThreadResumeParams,
  type ThreadStartParams,
} from "./app-server-protocol.js";

const log = createLogger("codex-app-server-manager");

export interface CodexThreadBinding {
  onNotification(method: string, params: unknown): void;
  onDynamicToolCall(call: DynamicToolCallParams): Promise<DynamicToolCallResponse>;
  onExit(error: Error): void;
}

export type CodexAppServerNotificationListener = (params: unknown) => void;
export type CodexAppServerExitListener = (error: Error) => void;

interface StoredThreadBinding {
  callbacks: CodexThreadBinding;
  config: ThreadStartParams;
  handle: CodexThreadHandle;
  generation: number;
  resumePromise: Promise<void> | null;
}

interface Connection {
  client: CodexAppServerConnection;
  generation: number;
  defaultProvider: string | null;
}

export interface CodexAppServerConnection {
  start(): void;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

/** Mutable because a cold resume can migrate the persisted history mode. */
export interface CodexThreadHandle {
  threadId: string;
  historyMode: ThreadHistoryMode | null;
}

export interface CodexAppServerManagerOptions {
  cwd?: string;
  /** Fixed child env. Defaults to the allowlist plus the instance credential, read at each spawn. */
  env?: Record<string, string>;
  /** Additional fixed root `-c` overrides, applied before Rome's provider configuration. */
  configArgs?: readonly string[];
  /** Codex's process-wide model provider. Null uses the guardian's OpenAI login. */
  defaultProvider?: string | null;
  createClient?: (options: AppServerClientOptions) => CodexAppServerConnection;
}

function defaultCodexEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  const instanceToken = getInstanceToken();
  if (instanceToken) env[ROME_CREDITS_TOKEN_ENV] = instanceToken;
  return env;
}

function threadFromResponse(result: unknown, method: string): CodexThreadHandle {
  const thread = (result as { thread?: { id?: unknown; historyMode?: unknown } } | undefined)
    ?.thread;
  const threadId = thread?.id;
  if (typeof threadId !== "string" || !threadId) {
    throw new Error(`codex ${method} did not return a thread id`);
  }
  const historyMode =
    thread?.historyMode === "legacy" || thread?.historyMode === "paginated"
      ? thread.historyMode
      : null;
  return { threadId, historyMode };
}

function threadIdFromParams(params: unknown): string | null {
  const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
  return typeof threadId === "string" && threadId ? threadId : null;
}

function buildThreadResumeParams(threadId: string, config: ThreadStartParams): ThreadResumeParams {
  return {
    threadId,
    ...toThreadConfigurationOverrides(config),
    excludeTurns: true,
  };
}

export class CodexAppServerManager {
  private readonly cwd: string;
  private readonly env: Record<string, string> | undefined;
  private readonly configArgs: readonly string[] | undefined;
  private readonly createClient: (options: AppServerClientOptions) => CodexAppServerConnection;
  private readonly bindings = new Map<string, StoredThreadBinding>();
  private readonly notificationListeners = new Map<
    string,
    Set<CodexAppServerNotificationListener>
  >();
  private readonly exitListeners = new Set<CodexAppServerExitListener>();
  private connection: Connection | null = null;
  private connectionPromise: Promise<Connection> | null = null;
  private startingClient: CodexAppServerConnection | null = null;
  private defaultProvider: string | null;
  // A→B→A restores defaultProvider, so this distinguishes the first, closed
  // client from a current one while it is still initializing.
  private connectionEpoch = 0;
  private nextGeneration = 1;
  private closed = false;

  constructor(options: CodexAppServerManagerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env;
    this.configArgs = options.configArgs;
    this.defaultProvider = options.defaultProvider ?? null;
    this.createClient =
      options.createClient ?? ((clientOptions) => new AppServerClient(clientOptions));
  }

  async warmup(): Promise<void> {
    await this.ensureConnection();
  }

  /**
   * Replace Codex immediately with a process whose default provider is
   * `provider`. This deliberately has the same effect as an app-server exit:
   * active turns fail, while idle threads lazily resume on their next request.
   */
  setDefaultProvider(provider: string | null): void {
    if (this.closed) throw new Error("codex app-server manager is closed");
    if (this.defaultProvider === provider) return;
    this.defaultProvider = provider;
    this.connectionEpoch += 1;

    const connection = this.connection;
    const startingClient = this.startingClient;
    this.connection = null;
    // Do not make a later request join an initialization that has the old
    // process default. Closing that client rejects its own in-flight callers.
    this.connectionPromise = null;
    const error = new Error("codex app-server exited (code null)");
    this.failCurrentGeneration(connection?.generation, error);
    connection?.client.close();
    if (!connection && startingClient) startingClient.close();
  }

  /** Issue a process-global app-server request on the shared connection. */
  async request<T>(method: string, params?: unknown): Promise<T> {
    const connection = await this.ensureConnection();
    return (await connection.client.request(method, params)) as T;
  }

  /**
   * Subscribe to a process-global notification such as
   * `account/login/completed`. These notifications do not carry a threadId,
   * so they cannot use the thread binding router below.
   */
  onNotification(method: string, listener: CodexAppServerNotificationListener): () => void {
    let listeners = this.notificationListeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.notificationListeners.set(method, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.notificationListeners.delete(method);
    };
  }

  /** Subscribe to an exit or deliberate replacement of the shared connection. */
  onExit(listener: CodexAppServerExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async openThread(
    config: ThreadStartParams,
    callbacks: CodexThreadBinding,
    resumeThreadId?: string,
  ): Promise<CodexThreadHandle> {
    if (this.closed) throw new Error("codex app-server manager is closed");
    const connection = await this.ensureConnection();
    const method = resumeThreadId ? Method.threadResume : Method.threadStart;
    const startedAt = Date.now();
    const result = await connection.client.request(
      method,
      resumeThreadId ? buildThreadResumeParams(resumeThreadId, config) : config,
    );
    const handle = threadFromResponse(result, method);
    const threadId = handle.threadId;
    if (resumeThreadId && threadId !== resumeThreadId) {
      throw new Error(
        `codex thread/resume returned unexpected thread id ${threadId} (wanted ${resumeThreadId})`,
      );
    }
    if (this.bindings.has(threadId)) {
      throw new Error(`codex thread is already bound: ${threadId}`);
    }
    this.bindings.set(threadId, {
      callbacks,
      config,
      handle,
      generation: connection.generation,
      resumePromise: null,
    });
    log.info("codex thread opened on shared app-server", {
      method,
      threadId,
      generation: connection.generation,
      durationMs: Date.now() - startedAt,
    });
    return handle;
  }

  async requestForThread<T>(threadId: string, method: string, params: unknown): Promise<T> {
    const connection = await this.ensureThreadSubscribed(threadId);
    return (await connection.client.request(method, params)) as T;
  }

  async unsubscribe(threadId: string): Promise<void> {
    const binding = this.bindings.get(threadId);
    if (!binding) return;
    try {
      const connection = this.connection;
      if (connection && binding.generation === connection.generation) {
        await connection.client.request(Method.threadUnsubscribe, { threadId });
      }
    } catch (err) {
      log.warn("codex thread unsubscribe failed", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.bindings.delete(threadId);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("codex app-server manager closed");
    for (const binding of this.bindings.values()) {
      try {
        binding.callbacks.onExit(error);
      } catch (err) {
        log.warn("codex thread exit handler failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.bindings.clear();
    this.notificationListeners.clear();
    this.exitListeners.clear();
    this.startingClient?.close();
    this.startingClient = null;
    this.connection?.client.close();
    this.connection = null;
    this.connectionPromise = null;
  }

  private async ensureThreadSubscribed(threadId: string): Promise<Connection> {
    const binding = this.bindings.get(threadId);
    if (!binding) throw new Error(`Unknown codex thread binding: ${threadId}`);
    const connection = await this.ensureConnection();
    if (binding.generation === connection.generation) return connection;
    if (!binding.resumePromise) {
      binding.resumePromise = (async () => {
        const startedAt = Date.now();
        const result = await connection.client.request(
          Method.threadResume,
          buildThreadResumeParams(threadId, binding.config),
        );
        const resumed = threadFromResponse(result, Method.threadResume);
        const resumedThreadId = resumed.threadId;
        if (resumedThreadId !== threadId) {
          throw new Error(
            `codex thread/resume returned unexpected thread id ${resumedThreadId} (wanted ${threadId})`,
          );
        }
        binding.handle.historyMode = resumed.historyMode;
        binding.generation = connection.generation;
        log.info("codex thread resumed after shared app-server restart", {
          threadId,
          generation: connection.generation,
          durationMs: Date.now() - startedAt,
        });
      })().finally(() => {
        binding.resumePromise = null;
      });
    }
    await binding.resumePromise;
    return connection;
  }

  private async ensureConnection(): Promise<Connection> {
    if (this.closed) throw new Error("codex app-server manager is closed");
    if (this.connection) return this.connection;
    if (this.connectionPromise) return await this.connectionPromise;

    const generation = this.nextGeneration++;
    const connectionEpoch = this.connectionEpoch;
    let connectionPromise!: Promise<Connection>;
    connectionPromise = this.createConnection(
      generation,
      this.defaultProvider,
      connectionEpoch,
    ).finally(() => {
      if (this.connectionPromise !== connectionPromise) return;
      this.connectionPromise = null;
    });
    this.connectionPromise = connectionPromise;
    return await this.connectionPromise;
  }

  private async createConnection(
    generation: number,
    defaultProvider: string | null,
    connectionEpoch: number,
  ): Promise<Connection> {
    const startedAt = Date.now();
    let exited = false;
    let client!: CodexAppServerConnection;
    client = this.createClient({
      cwd: this.cwd,
      env: this.env ?? defaultCodexEnvironment(),
      configArgs: [
        ...(this.configArgs ?? []),
        ...codexAppServerConfigArgs(getRomeCloudOrigin(), defaultProvider),
      ],
      onNotification: (method, params) => this.routeNotification(method, params),
      onServerRequest: async (method, params) => await this.routeServerRequest(method, params),
      onExit: (code) => {
        exited = true;
        this.handleExit(client, generation, code);
      },
    });
    this.startingClient = client;
    client.start();
    try {
      await client.request(Method.initialize, {
        clientInfo: { name: "rome", title: "Rome", version: "0" },
        capabilities: { experimentalApi: true },
      });
      client.notify(Method.initialized, {});
      if (exited) throw new Error("codex app-server exited during initialization");
      if (this.closed) throw new Error("codex app-server manager closed during initialization");
      if (connectionEpoch !== this.connectionEpoch) {
        throw new Error("codex app-server was replaced during initialization");
      }
      const connection = { client, generation, defaultProvider };
      this.connection = connection;
      log.info("codex shared app-server initialized", {
        generation,
        durationMs: Date.now() - startedAt,
      });
      return connection;
    } catch (err) {
      client.close();
      throw err;
    } finally {
      if (this.startingClient === client) this.startingClient = null;
    }
  }

  private routeNotification(method: string, params: unknown): void {
    for (const listener of this.notificationListeners.get(method) ?? []) {
      try {
        listener(params);
      } catch (err) {
        log.warn("codex global notification handler failed", {
          method,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const threadId = threadIdFromParams(params);
    if (!threadId) return;
    const binding = this.bindings.get(threadId);
    if (!binding) {
      log.debug("ignoring notification for unknown codex thread", { method, threadId });
      return;
    }
    binding.callbacks.onNotification(method, params);
  }

  private async routeServerRequest(method: string, params: unknown): Promise<unknown> {
    if (
      method === ServerRequestMethod.commandApproval ||
      method === ServerRequestMethod.fileChangeApproval
    ) {
      return { decision: "decline" };
    }
    if (method === ServerRequestMethod.requestUserInput) return { answers: [] };
    if (method !== ServerRequestMethod.dynamicToolCall) return {};

    const call = params as DynamicToolCallParams;
    const threadId = threadIdFromParams(call);
    const binding = threadId ? this.bindings.get(threadId) : undefined;
    if (!threadId || !binding) {
      return {
        contentItems: [{ type: "inputText", text: "Dynamic tool call for unknown thread" }],
        success: false,
      } satisfies DynamicToolCallResponse;
    }
    return await binding.callbacks.onDynamicToolCall(call);
  }

  private handleExit(
    client: CodexAppServerConnection,
    generation: number,
    code: number | null,
  ): void {
    if (this.closed || this.connection?.client !== client) return;
    const error = new Error(`codex app-server exited (code ${code ?? "null"})`);
    this.connection = null;
    this.failCurrentGeneration(generation, error);
  }

  private failCurrentGeneration(generation: number | undefined, error: Error): void {
    for (const listener of this.exitListeners) {
      try {
        listener(error);
      } catch (err) {
        log.warn("codex global exit handler failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const binding of this.bindings.values()) {
      if (generation !== undefined && binding.generation !== generation) continue;
      binding.generation = 0;
      try {
        binding.callbacks.onExit(error);
      } catch (err) {
        log.warn("codex thread exit handler failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
