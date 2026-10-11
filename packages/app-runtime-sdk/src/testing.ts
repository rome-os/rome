/**
 * Test kit for Rome apps: run an app's actions, API handler and hooks in a
 * plain test process, against its real migrations in an in-memory SQLite,
 * with no Rome daemon. Import from `@rome-os/app-runtime/testing`.
 *
 * ```ts
 * const app = await createTestApp({
 *   appId: "sales-agent",
 *   tablePrefix: "sales_agent",
 *   migrationsFolder: new URL("../src/db/migrations", import.meta.url),
 *   channelHistory: [
 *     channelMessage({ channel: "feishu", conversationId: "oc_sales", text: "Who owns Acme?" }),
 *   ],
 * });
 * await app.action("quote", createQuoteAction);
 * const result = await app.inChannel(
 *   { channel: "feishu", threadId: "oc_sales", channelUserId: "ou_mei", threadType: "group" },
 *   () => app.runAction("quote", { lines: [{ sku: "PRO", quantity: 3 }] }),
 * );
 * ```
 *
 * The in-memory database is Node's built-in `node:sqlite` (Node 22.16 or
 * later) behind the better-sqlite3 API the host's database has, so an app
 * needs no native addon to run its tests.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import {
  ActionInvocationError,
  setCurrentActionContextResolver,
  setCurrentActionContextRunner,
  toActionWireShape,
  type Action,
  type ActionConfig,
  type ActionInvocation,
  type ActionResult,
  type AppDbContext,
  type AppRuntimeRepositories,
  type AppStartedHook,
  type AppStartedHookDeps,
  type ChannelMessage,
  type ChannelMessageQuery,
  type ChannelsService,
  type ConversationId,
  type CurrentActionContext,
  type DrizzleDb,
  type Logger,
  type MessageReceipt,
  type OutgoingMessage,
  type RomeAppApiHandler,
  type RomeAppCaller,
  type RomeAppContext,
  type ThreadContext,
} from "./index.js";
import { NodeSqliteDatabase } from "./node-sqlite.js";
import { appMigrationsTableName } from "./packaging/manifest.js";

export interface TestDb {
  db: AppDbContext;
  close(): void;
}

/**
 * The app's tables in a fresh in-memory SQLite, created by running the app's
 * own migration files the way the host does at install.
 */
export async function createTestDb(options: {
  tablePrefix: string;
  /** The folder `drizzle-kit generate` writes, as a path or a `file:` URL. */
  migrationsFolder?: string | URL;
  /** A better-sqlite3-compatible constructor, such as better-sqlite3's own
   *  default export. Node's built-in `node:sqlite` when left out. */
  Database?: SqliteConstructor;
}): Promise<TestDb> {
  const sqlite = options.Database
    ? new options.Database(":memory:")
    : new NodeSqliteDatabase(":memory:");
  const connection = await drizzleOver(sqlite);
  if (options.migrationsFolder) {
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    migrate(connection as never, {
      migrationsFolder: toPath(options.migrationsFolder),
      migrationsTable: appMigrationsTableName(options.tablePrefix),
    });
  }
  const { tablePrefix } = options;
  return {
    db: { connection, tablePrefix, tableName: (name) => `${tablePrefix}__${name}` },
    close: () => sqlite.close(),
  };
}

interface SqliteHandle {
  close(): void;
}

export type SqliteConstructor = new (path: string) => SqliteHandle;

/** What `drizzle(client)` from `drizzle-orm/better-sqlite3` builds, without
 *  that entry's top-level import of the better-sqlite3 package. */
async function drizzleOver(client: SqliteHandle): Promise<DrizzleDb> {
  const [{ BaseSQLiteDatabase, SQLiteSyncDialect }, { BetterSQLiteSession }] = await Promise.all([
    import("drizzle-orm/sqlite-core"),
    import("drizzle-orm/better-sqlite3/session"),
  ]);
  const dialect = new SQLiteSyncDialect();
  const session = new BetterSQLiteSession(client as never, dialect, undefined, {});
  const db = new BaseSQLiteDatabase("sync", dialect, session as never, undefined);
  return Object.assign(db, { $client: client }) as unknown as DrizzleDb;
}

function toPath(value: string | URL): string {
  return value instanceof URL || value.startsWith("file:") ? fileURLToPath(value) : value;
}

export interface FakeChannels {
  service: ChannelsService;
  /** Every `query` call, oldest first. */
  queries: Array<{ channel: string; query?: ChannelMessageQuery }>;
  /** Every `send` call, oldest first. */
  sent: Array<{ channel: string; conversationId: ConversationId; message: OutgoingMessage }>;
  /** Add messages to the history later queries answer from. */
  push(...messages: ChannelMessage[]): void;
}

/**
 * A {@link ChannelsService} over a fixed history. `query` answers the way a
 * live channel does: newest first, narrowed by conversation and `since`,
 * capped by `limit` (default 100). `send` records the message and appends it
 * to the history as an outbound line.
 */
export function createFakeChannels(history: ChannelMessage[] = []): FakeChannels {
  const messages = [...history];
  const queries: FakeChannels["queries"] = [];
  const sent: FakeChannels["sent"] = [];
  let sequence = 0;

  const service: ChannelsService = {
    async list() {
      const names = new Set(messages.map((m) => m.channel));
      for (const s of sent) names.add(s.channel);
      return [...names].map((name) => ({ name, sendable: true }));
    },
    async send(channel, conversationId, message) {
      sent.push({ channel, conversationId, message });
      const messageId = `sent_${++sequence}`;
      messages.push({
        channel,
        direction: "outbound",
        messageId,
        conversationId,
        senderId: "",
        text: message.text ?? "",
        attachments: [],
        timestamp: new Date(),
      });
      return { messageId, conversationId } satisfies MessageReceipt;
    },
    async query(channel, query) {
      queries.push({ channel, ...(query ? { query } : {}) });
      const limit = Math.min(query?.limit ?? 100, 1000);
      return messages
        .filter((m) => m.channel === channel)
        .filter((m) => !query?.conversationId || m.conversationId === query.conversationId)
        .filter((m) => !query?.since || m.timestamp.getTime() >= query.since.getTime())
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, limit);
    },
  };

  return { service, queries, sent, push: (...more) => messages.push(...more) };
}

let messageSequence = 0;

/** A {@link ChannelMessage} with defaults for everything a test does not name.
 *  Set `conversationId` to the `threadId` an action passes to `inChannel` when
 *  the action reads its own conversation's history; the default matches none. */
export function channelMessage(
  fields: Partial<Omit<ChannelMessage, "conversationId">> & {
    channel: string;
    text: string;
    conversationId?: string;
  },
): ChannelMessage {
  return {
    direction: "inbound",
    messageId: `msg_${++messageSequence}`,
    senderId: "sender",
    attachments: [],
    timestamp: new Date(),
    ...fields,
    conversationId: (fields.conversationId ?? "conversation") as ConversationId,
  };
}

const actionContextStore = new AsyncLocalStorage<CurrentActionContext>();
const resolveTestContext = () => actionContextStore.getStore();
// Like the host's runner, a patch outside any turn runs without a context.
const runTestContext = <T>(patch: CurrentActionContext, run: () => Promise<T>): Promise<T> =>
  actionContextStore.getStore() ? withActionContext(patch, run) : run();

/**
 * Run `fn` as a turn on a channel conversation, so `getCurrentActionContext()`
 * inside it answers with `channelContext` the way it does when a channel
 * message reaches the app's agent. A nested call merges into the outer
 * context the way the host's `runWithCurrentActionContext` does, and
 * concurrent calls do not leak into each other.
 */
export function withActionContext<T>(
  context: CurrentActionContext,
  fn: () => Promise<T>,
): Promise<T> {
  // Installed on every call, since other code in the process can replace the
  // global hooks between calls.
  setCurrentActionContextResolver(resolveTestContext);
  setCurrentActionContextRunner(runTestContext);
  const outer = actionContextStore.getStore();
  if (!outer) return actionContextStore.run(context, fn);
  return actionContextStore.run(
    {
      ...outer,
      ...context,
      sharedContext:
        context.sharedContext === undefined
          ? outer.sharedContext
          : { ...outer.sharedContext, ...context.sharedContext },
    },
    fn,
  );
}

/** {@link withActionContext} for the common case: only the channel conversation. */
export function withChannelContext<T>(
  channelContext: ThreadContext,
  fn: () => Promise<T>,
): Promise<T> {
  return withActionContext({ channelContext }, fn);
}

/** An {@link ActionConfig} with the defaults an `action.yaml` would fill. */
export function testActionConfig(
  name: string,
  overrides: Partial<ActionConfig> = {},
): ActionConfig {
  return {
    name,
    type: "custom",
    description: name,
    complexity: "simple",
    speed: "fast",
    reliability: "high",
    sideEffects: "read-only",
    ...overrides,
  };
}

/** A logger that keeps every line, for assertions, and prints nothing. */
export interface RecordingLogger extends Logger {
  lines: Array<{
    level: "debug" | "info" | "warn" | "error";
    message: string;
    data?: Record<string, unknown>;
  }>;
}

export function createRecordingLogger(): RecordingLogger {
  const lines: RecordingLogger["lines"] = [];
  const at =
    (level: RecordingLogger["lines"][number]["level"]) =>
    (message: string, data?: Record<string, unknown>) => {
      lines.push({ level, message, ...(data ? { data } : {}) });
    };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** The `createAction(config, deps)` an action module exports. */
export type ActionFactory<TDeps> = (config: ActionConfig, deps: TDeps) => Action | Promise<Action>;

export interface TestApiResponse {
  status: number;
  headers: Headers;
  /** The body parsed as JSON, or the raw text when it is not JSON. */
  body: unknown;
}

export interface TestApp {
  appId: string;
  db: AppDbContext;
  channels: FakeChannels;
  logger: RecordingLogger;
  /** In-memory app settings, as `appContext.repositories.settings` reads them. */
  settings: Map<string, unknown>;
  /** What the host hands `createApiHandler(ctx)` and every action's `deps.appContext`. */
  appContext: RomeAppContext;
  /** The deps an action's `createAction(config, deps)` receives. */
  deps: { appContext: RomeAppContext; channelsService: ChannelsService } & Record<string, unknown>;
  /**
   * Instantiate an action from its module's factory and register it as
   * `<appId>:<name>`, the only name `appContext.runAction` finds it by, as in
   * the host.
   */
  action<TDeps>(
    name: string,
    factory: ActionFactory<TDeps>,
    config?: Partial<ActionConfig>,
  ): Promise<Action>;
  /**
   * Run a registered action the way the host does: arguments and result cross
   * a JSON boundary, so a `Date` arrives as a string and an unserializable
   * value fails with {@link ActionInvocationError}. A bare `name` is taken as
   * this app's `<appId>:<name>`; `appContext.runAction` has no such shortcut.
   */
  runAction(name: string, args?: Record<string, unknown>): Promise<ActionResult>;
  /** Run `fn` as a turn in a channel conversation; see {@link withChannelContext}. */
  inChannel<T>(channelContext: ThreadContext, fn: () => Promise<T>): Promise<T>;
  /** Run the app's `app-started` hook from its `createHook(deps)` factory. */
  start(
    createHook: (deps: AppStartedHookDeps) => AppStartedHook | Promise<AppStartedHook>,
    appVersion?: string,
  ): Promise<void>;
  /** Call the app's API handler from its `createApiHandler(ctx)` factory. */
  api(createApiHandler: (ctx: RomeAppContext) => RomeAppApiHandler): {
    request(
      method: string,
      path: string,
      init?: { body?: unknown; caller?: RomeAppCaller; headers?: Record<string, string> },
    ): Promise<TestApiResponse>;
  };
  close(): void;
}

/**
 * One app wired the way the host wires it, minus the daemon: a migrated
 * in-memory database, a fake channels service, in-memory settings, and an
 * action registry behind `appContext.runAction`.
 *
 * Host services an app cannot meaningfully use in a test (favors, routines,
 * the agent runner) reject with a message naming the service, so a test that
 * reaches one fails loudly instead of passing on a stub.
 */
export async function createTestApp(options: {
  appId: string;
  /** `appContext.app.version` and the app-started hook's version, as app.yaml's
   *  `version` gives them on the host. */
  appVersion?: string;
  /** `appContext.app.description`, app.yaml's `description`. */
  description?: string;
  tablePrefix?: string;
  migrationsFolder?: string | URL;
  channelHistory?: ChannelMessage[];
  /** Extra deps merged into every action's `deps`, after the defaults. */
  deps?: Record<string, unknown>;
  /** Answers `runAction` for a name no `app.action` registered, such as a
   *  `system:` action. Left out, such a call rejects with `not_found`. */
  unknownAction?: (name: string, args: Record<string, unknown>) => Promise<ActionResult>;
  /** Replaces host services on `appContext`, such as `listRoutines`. */
  appContext?: Partial<Pick<RomeAppContext, "favors" | "listRoutines" | "repositories">>;
  /** A better-sqlite3-compatible constructor; see {@link createTestDb}. */
  Database?: SqliteConstructor;
}): Promise<TestApp> {
  // The host's fallback when app.yaml declares no db.tablePrefix.
  const tablePrefix = options.tablePrefix ?? options.appId;
  const { db, close } = await createTestDb({
    tablePrefix,
    ...(options.migrationsFolder ? { migrationsFolder: options.migrationsFolder } : {}),
    ...(options.Database ? { Database: options.Database } : {}),
  });
  const channels = createFakeChannels(options.channelHistory);
  const logger = createRecordingLogger();
  const settings = new Map<string, unknown>();
  const actions = new Map<string, Action>();

  const unavailable = (service: string) => () =>
    Promise.reject(
      new Error(
        `${service} is not available in createTestApp; pass a fake through options.appContext`,
      ),
    );

  const repositories: AppRuntimeRepositories = {
    settings: {
      async get<T>(key: string) {
        return (settings.has(key) ? settings.get(key) : null) as T | null;
      },
      async set(key, value) {
        settings.set(key, value);
      },
    },
  };

  const runAction = async (
    name: string,
    args: Record<string, unknown> = {},
    runOptions?: { detached?: boolean },
  ): Promise<ActionResult> => {
    if (runOptions?.detached) {
      throw new Error(
        `runAction("${name}", { detached: true }) is not available in createTestApp; a detached run needs the host's dispatcher`,
      );
    }
    const action = actions.get(name);
    if (!action && options.unknownAction) {
      const result = await options.unknownAction(name, toActionWireShape(args, name, "args"));
      return toActionWireShape(result, name, "result");
    }
    if (!action) {
      throw new ActionInvocationError(
        name,
        "not_found",
        actions.has(`${options.appId}:${name}`)
          ? `No action "${name}"; Rome resolves an app's actions as "${options.appId}:${name}"`
          : `No action "${name}" is registered; call app.action(name, createAction) first`,
      );
    }
    const wireArgs = toActionWireShape(args, name, "args");
    let result: ActionResult;
    try {
      result = await action.execute(wireArgs);
    } catch (err) {
      // As in the host, anything the handler throws, a failed nested
      // runAction included, fails this action with handler_error.
      if (err instanceof Error && err.name === "ActionCancelledError") throw err;
      throw new ActionInvocationError(
        name,
        "handler_error",
        err instanceof Error ? err.message : String(err),
      );
    }
    return toActionWireShape(result, name, "result");
  };

  const appContext: RomeAppContext = {
    app: {
      id: options.appId,
      version: options.appVersion ?? "0.0.0-test",
      description: options.description ?? options.appId,
    },
    controller: undefined,
    db,
    log: logger,
    repositories,
    favors: { requestAction: unavailable("favors.requestAction") },
    runAction: runAction as RomeAppContext["runAction"],
    invokeAction<TEvent extends { type: string }, TOutput>(
      name: string,
      args: Record<string, unknown>,
    ) {
      return {
        events: (async function* () {})(),
        result: runAction(name, args),
      } as unknown as ActionInvocation<TEvent, TOutput>;
    },
    listRoutines: unavailable("listRoutines"),
    ...options.appContext,
  };

  const agentRunnerUnavailable = () => {
    throw new Error(
      "agentRunner is not available in createTestApp; pass a fake through options.deps",
    );
  };
  const agentRunner = { run: agentRunnerUnavailable, runForked: agentRunnerUnavailable };
  const deps = {
    channelsService: channels.service,
    agentRunner,
    ...options.deps,
    appContext,
  };

  return {
    appId: options.appId,
    db,
    channels,
    logger,
    settings,
    appContext,
    deps,
    async action(name, factory, config) {
      const action = await factory(testActionConfig(name, config), deps as never);
      actions.set(`${options.appId}:${name}`, action);
      return action;
    },
    runAction: (name, args) =>
      runAction(name.includes(":") ? name : `${options.appId}:${name}`, args),
    inChannel: withChannelContext,
    async start(createHook, appVersion = options.appVersion ?? "0.0.0-test") {
      // The host awaits createHook, so an async factory works there too.
      const hook = await createHook({
        appId: options.appId,
        logger,
        appContext,
        agentRunner: deps.agentRunner as AppStartedHookDeps["agentRunner"],
      });
      if (typeof hook?.onAppStarted !== "function") {
        throw new Error("The app-started hook must implement onAppStarted(event)");
      }
      await hook.onAppStarted({
        type: "app-started",
        version: 1,
        appId: options.appId,
        appVersion,
      });
    },
    api(createApiHandler) {
      return {
        async request(method, path, init = {}) {
          const url = new URL(path.replace(/^\/+/, ""), "http://app.test/");
          const body =
            init.body === undefined
              ? undefined
              : init.body instanceof Uint8Array
                ? init.body
                : new TextEncoder().encode(
                    typeof init.body === "string" ? init.body : JSON.stringify(init.body),
                  );
          // The host builds a handler per request, so factory state does not
          // carry over between requests here either.
          const response = await createApiHandler(appContext).handle({
            method: method.toUpperCase(),
            path: url.pathname.split("/").filter(Boolean).map(decodeURIComponent),
            headers: { ...(body ? { "content-type": "application/json" } : {}), ...init.headers },
            query: url.searchParams,
            ...(body ? { body } : {}),
            caller: init.caller ?? { kind: "guardian", userId: "guardian", via: "cookie" },
          });
          const text = await response.text();
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            // Not JSON; the raw text is the body.
          }
          return { status: response.status, headers: response.headers, body: parsed };
        },
      };
    },
    close,
  };
}
