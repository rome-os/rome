import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createRomeAppContext,
  type RomeAppContext,
  type RomeAppRuntimeServices,
} from "./context.js";
import { createAppRuntimeRepositories } from "./repositories.js";
import { AppApiDispatcher } from "./api.js";
import type { AppCatalog } from "./catalog.js";
import type { ResolvedApp } from "./state.js";
import type { Action, ActionConfig, ActionResult } from "../actions/types.js";
import type { ActionLoader } from "../actions/loader.js";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import {
  ActionInvocationError,
  ActionInvocationEventOverflowError,
  getCurrentActionContext,
} from "@rome-os/app-runtime";
import { registerAppActions, registerLazyAppActions } from "../actions/app-actions-wiring.js";
import { bumpModuleEnvEpoch } from "../actions/module-loader.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { FavorActionRequestView, FavorService } from "../favors/types.js";

type RuntimeContextCapture = {
  surface: "action" | "api";
  appId: string;
  repositories: RomeAppRuntimeServices["repositories"];
};

type RuntimeContextGlobal = typeof globalThis & {
  __romeAppRuntimeContexts?: RuntimeContextCapture[];
  __lazyActionEvents?: string[];
};

describe("app runtime context", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    delete (globalThis as RuntimeContextGlobal).__romeAppRuntimeContexts;
    delete (globalThis as RuntimeContextGlobal).__lazyActionEvents;
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("includes the configured repository bag", () => {
    const repositories = createRepositories();
    const context = createRomeAppContext(resolvedApp("ctx-app"), {
      catalog: catalogFor(resolvedApp("ctx-app")),
      db: {} as RomeAppRuntimeServices["db"],
      actionEngine: {} as ActionEngine,
      repositories,
    });

    expect(context.app).toEqual({
      id: "ctx-app",
      version: "1.2.3",
      description: "Test app",
    });
    expect(context.controller).toBeUndefined();
    expect(context.repositories).toBe(repositories);
  });

  it("exposes adapter ports instead of broad internal repository objects", () => {
    const settingsRepo = {
      get: rs.fn(async () => null),
      set: rs.fn(async () => undefined),
      delete: rs.fn(async () => undefined),
      getAll: rs.fn(async () => ({})),
    } as unknown as SettingsRepository;
    const webchatRepo = {
      getSession: rs.fn(async () => null),
      getMessages: rs.fn(async () => []),
      addTurnRecapMessage: rs.fn(),
      deleteSession: rs.fn(),
    } as unknown as WebChatRepository;

    const repositories = createAppRuntimeRepositories({ settingsRepo, webchatRepo });

    expect("delete" in repositories.settings).toBe(false);
    expect("getAll" in repositories.settings).toBe(false);
    expect("deleteSession" in repositories.webchatRecaps!).toBe(false);
  });

  it("provides the same repository context shape to app actions and app APIs", async () => {
    const app = resolvedApp("shared-context-app");
    const repositories = createRepositories();
    const services: RomeAppRuntimeServices = {
      catalog: catalogFor(app),
      db: {} as RomeAppRuntimeServices["db"],
      actionEngine: { run: rs.fn() } as unknown as ActionEngine,
      repositories,
    };

    const actionDir = await tempDir();
    await writeFile(
      join(actionDir, "index.js"),
      `
export function createAction(config, deps) {
  globalThis.__romeAppRuntimeContexts ??= [];
  globalThis.__romeAppRuntimeContexts.push({
    surface: "action",
    appId: deps.appContext.app.id,
    repositories: deps.appContext.repositories,
  });
  return { config, execute: async () => ({ status: "ok" }) };
}
`,
      "utf-8",
    );

    const actionLoader = {
      getAllRecords() {
        return new Map([
          [
            "probe_action",
            {
              config: actionConfig("probe_action"),
              directory: actionDir,
              metadata: {
                kind: "action",
                ownerType: "app",
                ownerId: app.appId,
                publicName: "probe_action",
                aliases: [],
                sourcePath: actionDir,
              },
            },
          ],
        ]);
      },
    } as unknown as ActionLoader;

    const registry = new ActionRegistryImpl([]);
    const actionLoad = await registerAppActions(
      actionLoader,
      registry,
      services.catalog,
      {},
      services,
    );
    expect(actionLoad.failed).toEqual([]);

    const apiEntryPath = join(await tempDir(), "index.js");
    await writeFile(
      apiEntryPath,
      `
export function createApiHandler(ctx) {
  globalThis.__romeAppRuntimeContexts ??= [];
  globalThis.__romeAppRuntimeContexts.push({
    surface: "api",
    appId: ctx.app.id,
    repositories: ctx.repositories,
  });
  return { handle: async () => new Response("ok") };
}
`,
      "utf-8",
    );

    const apiApp = resolvedApp("shared-context-app", { apiEntryPath });
    await new AppApiDispatcher(catalogFor(apiApp), services).dispatch(apiApp.appId, {
      method: "GET",
      path: ["probe"],
      headers: {},
      query: new URLSearchParams(),
      caller: { kind: "anonymous" },
    });

    expect((globalThis as RuntimeContextGlobal).__romeAppRuntimeContexts).toEqual([
      { surface: "action", appId: "shared-context-app", repositories },
      { surface: "api", appId: "shared-context-app", repositories },
    ]);
  });

  it("re-evaluates module-scope env reads after an app-keys refresh", async () => {
    // An API module that captures env at module scope stays cached across
    // dispatches — the import cache key is file identity, so an env change
    // alone never reaches it. The app-keys refresh bumps the module env epoch;
    // this pins both halves: stale without the bump, fresh after it.
    const TEST_KEY = "APP_KEYS_MODULE_SCOPE_PROBE";
    const apiEntryPath = join(await tempDir(), "index.js");
    await writeFile(
      apiEntryPath,
      `
const CAPTURED = process.env.${TEST_KEY} ?? "unset";
export function createApiHandler() {
  return { handle: async () => new Response(CAPTURED) };
}
`,
      "utf-8",
    );

    const app = resolvedApp("env-probe-app", { apiEntryPath });
    const dispatcher = new AppApiDispatcher(catalogFor(app), {
      db: {} as RomeAppRuntimeServices["db"],
      actionEngine: {} as ActionEngine,
      repositories: createRepositories(),
    });
    const request = {
      method: "GET",
      path: ["probe"],
      headers: {},
      query: new URLSearchParams(),
      caller: { kind: "anonymous" } as const,
    };

    try {
      expect(await (await dispatcher.dispatch(app.appId, request)).text()).toBe("unset");

      process.env[TEST_KEY] = "v1";
      expect(await (await dispatcher.dispatch(app.appId, request)).text()).toBe("unset");

      bumpModuleEnvEpoch();
      expect(await (await dispatcher.dispatch(app.appId, request)).text()).toBe("v1");
    } finally {
      delete process.env[TEST_KEY];
    }
  });

  it("can register app action stubs without importing the implementation until execution", async () => {
    const app = resolvedApp("lazy-action-app");
    const repositories = createRepositories();
    const services: RomeAppRuntimeServices = {
      catalog: catalogFor(app),
      db: {} as RomeAppRuntimeServices["db"],
      actionEngine: { run: rs.fn() } as unknown as ActionEngine,
      repositories,
    };

    const actionDir = await tempDir();
    await writeFile(
      join(actionDir, "index.js"),
      `
globalThis.__lazyActionEvents ??= [];
globalThis.__lazyActionEvents.push("module");

export function createAction(config, deps) {
  globalThis.__lazyActionEvents.push("factory:" + deps.appContext.app.id);
  return {
    config,
    preview: async () => ({ kind: "generic", title: "Lazy", summary: "Loaded" }),
    execute: async (_args, context) => {
      context.emitActionEvent({ type: "lazy_started" });
      globalThis.__lazyActionEvents.push("execute");
      return { status: "ok" };
    },
  };
}
`,
      "utf-8",
    );

    const actionLoader = {
      getAllRecords() {
        return new Map([
          [
            "lazy_action",
            {
              config: actionConfig("lazy_action"),
              directory: actionDir,
              metadata: {
                kind: "action",
                ownerType: "app",
                ownerId: app.appId,
                publicName: "lazy_action",
                aliases: [],
                sourcePath: actionDir,
              },
            },
          ],
        ]);
      },
    } as unknown as ActionLoader;

    const registry = new ActionRegistryImpl([]);
    const actionLoad = registerLazyAppActions(
      actionLoader,
      registry,
      services.catalog,
      {},
      services,
    );

    expect(actionLoad).toEqual({ loaded: ["lazy_action"], failed: [] });
    expect((globalThis as RuntimeContextGlobal).__lazyActionEvents).toBeUndefined();

    const action = registry.get("lazy_action");
    expect(action?.config.name).toBe("lazy_action");
    const emitted: unknown[] = [];
    await expect(
      action?.execute(
        {},
        {
          emitActionEvent(event) {
            emitted.push(event);
          },
        },
      ),
    ).resolves.toEqual({ status: "ok" });
    expect(emitted).toEqual([{ type: "lazy_started" }]);
    expect((globalThis as RuntimeContextGlobal).__lazyActionEvents).toEqual([
      "module",
      "factory:lazy-action-app",
      "execute",
    ]);
  });

  it("binds favor action-request creation to the app-api requester identity", async () => {
    const repositories = createRepositories();
    const requestAction = rs.fn(async (input) => ({
      status: "pending_consent" as const,
      request: favorRequestView(input.app.appId),
      authorizationUrl: "https://rome-cloud.test/favors/action-requests/favor-1/authorize",
    }));
    const favorService = { requestAction } as unknown as FavorService;
    const apiEntryPath = join(await tempDir(), "index.js");
    await writeFile(
      apiEntryPath,
      `
export function createApiHandler(ctx) {
  return {
    async handle() {
      const result = await ctx.favors.requestAction({
        actionName: "ship",
        args: { packageId: "pkg-1" },
        taskRef: { taskId: "task-1" },
        idempotencyKey: "idem-1",
      });
      return Response.json(result);
    },
  };
}
`,
      "utf-8",
    );

    const apiApp = resolvedApp("trusted-app", { apiEntryPath });
    const services: RomeAppRuntimeServices = {
      catalog: catalogFor(apiApp),
      db: {} as RomeAppRuntimeServices["db"],
      actionEngine: { run: rs.fn() } as unknown as ActionEngine,
      repositories,
      favorService,
    };

    const res = await new AppApiDispatcher(catalogFor(apiApp), services).dispatch(
      apiApp.appId,
      {
        method: "POST",
        path: ["favor"],
        headers: {},
        query: new URLSearchParams(),
        caller: {
          kind: "visitor",
          accountId: "acct-1",
          email: "visitor@example.test",
        },
      },
      {
        viewer: {
          accountId: "acct-1",
          email: "visitor@example.test",
          favorViewerToken: "favor-viewer-token",
        },
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "pending_consent",
      requestId: "favor-1",
      authorizationUrl: "https://rome-cloud.test/favors/action-requests/favor-1/authorize",
      request: { requesterAppId: "trusted-app" },
    });
    expect(requestAction).toHaveBeenCalledWith({
      app: apiApp,
      viewer: {
        accountId: "acct-1",
        email: "visitor@example.test",
        favorViewerToken: "favor-viewer-token",
      },
      actionName: "ship",
      args: { packageId: "pkg-1" },
      taskRef: { taskId: "task-1" },
      idempotencyKey: "idem-1",
    });
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "rome-app-runtime-context-"));
    tempDirs.push(dir);
    return dir;
  }
});

// Behavior pins: runAction is the transport-blind invocation port.
// Every failure surfaces as ActionInvocationError, and data crosses the port
// with fork-IPC JSON semantics even when the callee runs in-process.
describe("runAction invocation port", () => {
  function contextWithActions(actions: Action[]) {
    const registry = new ActionRegistryImpl([]);
    for (const action of actions) {
      registry.register(action);
    }
    const engine = new ActionEngine(registry);
    return createRomeAppContext(resolvedApp("invoker-app"), {
      catalog: catalogFor(resolvedApp("invoker-app")),
      db: {} as RomeAppRuntimeServices["db"],
      actionEngine: engine,
      repositories: createRepositories(),
    });
  }

  function probeAction(name: string, execute: Action["execute"]): Action {
    return { config: actionConfig(name), execute };
  }

  it("rejects with code not_found for an unknown action", async () => {
    const context = contextWithActions([]);
    const err = await context.runAction("nope", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionInvocationError);
    expect(err).toMatchObject({ actionName: "nope", code: "not_found" });
  });

  it("rejects a detached dispatch before acknowledgement when main does not know the action", async () => {
    const engine = new ActionEngine(
      new ActionRegistryImpl([]),
      undefined,
      undefined,
      undefined,
      undefined,
      { processRole: "main", workerWarmPoolSize: 0, actionWorkerFork: rs.fn() },
    );
    const context = createRomeAppContext(resolvedApp("invoker-app"), {
      catalog: catalogFor(resolvedApp("invoker-app")),
      db: {} as RomeAppRuntimeServices["db"],
      actionEngine: engine,
      repositories: createRepositories(),
    });

    const err = await context
      .runAction("nope", {}, { detached: true })
      .catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ActionInvocationError);
    expect(err).toMatchObject({ actionName: "nope", code: "not_found" });
  });

  it("rejects with code handler_error carrying the handler's message", async () => {
    const context = contextWithActions([
      probeAction("explodes", async () => {
        throw new TypeError("boom from handler");
      }),
    ]);
    const err = await context.runAction("explodes", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionInvocationError);
    expect(err).toMatchObject({
      actionName: "explodes",
      code: "handler_error",
      message: "boom from handler",
    });
  });

  it("rejects circular args with code unserializable without executing the callee", async () => {
    const execute = rs.fn(async () => ({ status: "ok" }) as ActionResult);
    const context = contextWithActions([probeAction("never_runs", execute)]);
    const args: Record<string, unknown> = {};
    args.self = args;
    const err = await context.runAction("never_runs", args).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionInvocationError);
    expect(err).toMatchObject({ actionName: "never_runs", code: "unserializable" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("applies fork-IPC JSON semantics to args even in-process (Date → string, undefined dropped)", async () => {
    let seen: Record<string, unknown> | undefined;
    const context = contextWithActions([
      probeAction("inspects_args", async (args) => {
        seen = args;
        return { status: "ok" };
      }),
    ]);
    await context.runAction("inspects_args", {
      when: new Date("2026-01-02T03:04:05.000Z"),
      missing: undefined,
      kept: 1,
    });
    expect(seen).toEqual({ when: "2026-01-02T03:04:05.000Z", kept: 1 });
    expect(Object.keys(seen!)).not.toContain("missing");
  });

  it("stamps callerAppId with the invoking app so the callee can attribute the work", async () => {
    // The app never passes its id; the runtime derives it from the context it
    // built (here "invoker-app") and the callee reads it off the ambient context.
    let seenCallerAppId: string | undefined;
    const context = contextWithActions([
      probeAction("reads_caller", async () => {
        seenCallerAppId = getCurrentActionContext()?.callerAppId;
        return { status: "ok" };
      }),
    ]);
    await context.runAction("reads_caller", {});
    expect(seenCallerAppId).toBe("invoker-app");
  });

  it("never shares references across the port: callee arg mutations are invisible to the caller", async () => {
    const context = contextWithActions([
      probeAction("mutates", async (args) => {
        (args.payload as Record<string, unknown>).tampered = true;
        return { status: "ok", data: { echoed: args.payload } };
      }),
    ]);
    const payload: Record<string, unknown> = { original: true };
    const result = await context.runAction("mutates", { payload });
    expect(payload).toEqual({ original: true });
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.data).toEqual({ echoed: { original: true, tampered: true } });
  });

  it("returns a failed ActionResult as a value, not an exception", async () => {
    const context = contextWithActions([
      probeAction("declines", async () => ({ status: "error", error: "no thanks" })),
    ]);
    await expect(context.runAction("declines", {})).resolves.toEqual({
      status: "error",
      error: "no thanks",
    });
  });

  it("passes cancellation through unwrapped as a control signal", async () => {
    const cancelled = new Error("Cancelled by user");
    cancelled.name = "ActionCancelledError";
    const context = contextWithActions([
      probeAction("gets_cancelled", async () => {
        throw cancelled;
      }),
    ]);
    const err = await context.runAction("gets_cancelled", {}).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ActionInvocationError);
    expect(err).toMatchObject({ name: "ActionCancelledError", message: "Cancelled by user" });
  });

  it("normalizes nested invocations the same way when called from inside an action body", async () => {
    const inner = probeAction("inner_explodes", async () => {
      throw new Error("inner failure");
    });
    let nestedErr: unknown;
    const context: RomeAppContext = contextWithActions([
      inner,
      probeAction("outer", async () => {
        nestedErr = await context.runAction("inner_explodes", {}).catch((e: unknown) => e);
        return { status: "ok" };
      }),
    ]);
    await context.runAction("outer", {});
    expect(nestedErr).toBeInstanceOf(ActionInvocationError);
    expect(nestedErr).toMatchObject({
      actionName: "inner_explodes",
      code: "handler_error",
      message: "inner failure",
    });
  });

  it("re-attributes a bubbled nested failure to the action this caller invoked", async () => {
    const inner = probeAction("inner_explodes", async () => {
      throw new Error("inner failure");
    });
    const context: RomeAppContext = contextWithActions([
      inner,
      probeAction("outer", async () => {
        // The handler lets the nested ActionInvocationError escape unhandled.
        await context.runAction("inner_explodes", {});
        return { status: "ok" };
      }),
    ]);
    const err = await context.runAction("outer", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionInvocationError);
    expect(err).toMatchObject({
      actionName: "outer",
      code: "handler_error",
      message: "inner failure",
    });
  });

  it("starts invokeAction eagerly and delivers an event before the result", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const context = contextWithActions([
      probeAction("eventful", async (_args, execution) => {
        execution!.emitActionEvent({ type: "started", resource: { id: "resource-1" } });
        await gate;
        return { status: "ok", data: { completed: true } };
      }),
    ]);

    const invocation = context.invokeAction<{
      type: "started";
      resource: { id: string };
    }>("eventful", {});
    const iterator = invocation.events[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "started", resource: { id: "resource-1" } },
    });

    let resultSettled = false;
    void invocation.result.then(() => {
      resultSettled = true;
    });
    await Promise.resolve();
    expect(resultSettled).toBe(false);

    await iterator.return?.();
    finish();
    await expect(invocation.result).resolves.toEqual({
      status: "ok",
      data: { completed: true },
    });
  });

  it("allows only one consumer for an invocation event stream", async () => {
    const context = contextWithActions([
      probeAction("single_consumer", async () => ({ status: "ok" })),
    ]);
    const invocation = context.invokeAction("single_consumer", {});
    invocation.events[Symbol.asyncIterator]();

    expect(() => invocation.events[Symbol.asyncIterator]()).toThrow(
      "Action invocation events can only be consumed once",
    );
    await expect(invocation.result).resolves.toEqual({ status: "ok" });
  });

  it("resolves concurrent next calls in FIFO order", async () => {
    let publish!: () => void;
    const gate = new Promise<void>((resolve) => {
      publish = resolve;
    });
    const context = contextWithActions([
      probeAction("concurrent_next", async (_args, execution) => {
        await gate;
        execution!.emitActionEvent({ type: "progress", sequence: 1 });
        execution!.emitActionEvent({ type: "progress", sequence: 2 });
        return { status: "ok" };
      }),
    ]);
    const invocation = context.invokeAction<{ type: "progress"; sequence: number }>(
      "concurrent_next",
      {},
    );
    const iterator = invocation.events[Symbol.asyncIterator]();
    const first = iterator.next();
    const second = iterator.next();
    const end = iterator.next();

    publish();

    await expect(first).resolves.toEqual({
      done: false,
      value: { type: "progress", sequence: 1 },
    });
    await expect(second).resolves.toEqual({
      done: false,
      value: { type: "progress", sequence: 2 },
    });
    await expect(end).resolves.toEqual({ done: true, value: undefined });
    await expect(invocation.result).resolves.toEqual({ status: "ok" });
  });

  it("fails only the event stream when its 32-event queue overflows", async () => {
    const context = contextWithActions([
      probeAction("event_overflow", async (_args, execution) => {
        for (let sequence = 0; sequence < 33; sequence += 1) {
          execution!.emitActionEvent({ type: "progress", sequence });
        }
        return { status: "ok", data: { completed: true } };
      }),
    ]);

    const invocation = context.invokeAction("event_overflow", {});
    await expect(invocation.result).resolves.toEqual({
      status: "ok",
      data: { completed: true },
    });
    const iterator = invocation.events[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBeInstanceOf(ActionInvocationEventOverflowError);
  });

  it("keeps descendant events direct unless the parent re-emits them", async () => {
    let context: RomeAppContext;
    const child = probeAction("child", async (_args, execution) => {
      execution!.emitActionEvent({ type: "child_started" });
      return { status: "ok" };
    });
    const parent = probeAction("parent", async (_args, execution) => {
      const childInvocation = context.invokeAction<{ type: "child_started" }>("child", {});
      const childEvents: string[] = [];
      for await (const event of childInvocation.events) childEvents.push(event.type);
      await childInvocation.result;
      execution!.emitActionEvent({ type: "parent_started", childEvents });
      return { status: "ok" };
    });
    context = contextWithActions([child, parent]);

    const invocation = context.invokeAction<{
      type: "parent_started";
      childEvents: string[];
    }>("parent", {});
    const events: unknown[] = [];
    for await (const event of invocation.events) events.push(event);

    expect(events).toEqual([{ type: "parent_started", childEvents: ["child_started"] }]);
    await expect(invocation.result).resolves.toEqual({ status: "ok" });
  });

  it("fails invalid public events at the emitting handler", async () => {
    const context = contextWithActions([
      probeAction("bad_event", async (_args, execution) => {
        const event: Record<string, unknown> = { type: "bad" };
        event.self = event;
        execution!.emitActionEvent(event as { type: string });
        return { status: "ok" };
      }),
    ]);

    const invocation = context.invokeAction("bad_event", {});
    const events = invocation.events[Symbol.asyncIterator]();
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(invocation.result).rejects.toMatchObject({
      name: "ActionInvocationError",
      code: "handler_error",
    });
  });

  it("snapshots an event at the emission boundary", async () => {
    const context = contextWithActions([
      probeAction("event_snapshot", async (_args, execution) => {
        const event = { type: "started", resource: { id: "original" } };
        execution!.emitActionEvent(event);
        event.resource.id = "mutated-after-emit";
        return { status: "ok" };
      }),
    ]);

    const invocation = context.invokeAction<{
      type: "started";
      resource: { id: string };
    }>("event_snapshot", {});
    const events: unknown[] = [];
    for await (const event of invocation.events) events.push(event);

    expect(events).toEqual([{ type: "started", resource: { id: "original" } }]);
    await expect(invocation.result).resolves.toEqual({ status: "ok" });
  });
});

function createRepositories(): RomeAppRuntimeServices["repositories"] {
  return {
    settings: {
      get: rs.fn(async () => null),
      set: rs.fn(async () => undefined),
    },
    webchatRecaps: {
      getSession: rs.fn(async () => null),
      getMessages: rs.fn(async () => []),
      addTurnRecapMessage: rs.fn(),
    },
  };
}

function actionConfig(name: string): ActionConfig {
  return {
    name,
    type: "custom",
    description: "Probe action",
    complexity: "simple",
    speed: "fast",
    reliability: "high",
    sideEffects: "read-only",
  };
}

function catalogFor(app: ResolvedApp): AppCatalog {
  return {
    get(appId: string) {
      return appId === app.appId ? app : null;
    },
  } as unknown as AppCatalog;
}

function resolvedApp(appId: string, options: { apiEntryPath?: string } = {}): ResolvedApp {
  return {
    appId,
    state: "installed",
    enabled: true,
    firstParty: false,
    source: { mode: "bundle", path: "/tmp/app" },
    installedHash: "0".repeat(64),
    installedVersion: "1.2.3",
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    manifest: {
      id: appId,
      version: "1.2.3",
      description: "Test app",
      agents: [],
      actions: [],
      skills: [],
      hooks: [],
    },
    rootPath: "/tmp/app",
    resolveRoot: "/tmp/app",
    displayName: appId,
    iconAbsolutePath: undefined,
    artifacts: { agent: [], action: [], skill: [], hook: [] },
    web: null,
    api: options.apiEntryPath
      ? { appId, entryPath: options.apiEntryPath, noAuth: false, relayWebhook: null }
      : null,
    db: null,
  };
}

function favorRequestView(appId: string): FavorActionRequestView {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "favor-1",
    payerUserId: null,
    requestorUserId: "owner-1",
    recipientUserId: "owner-1",
    requesterInstanceId: "instance-1",
    requesterAppId: appId,
    requesterAppIdentity: { appId },
    actionName: "ship",
    definitionHash: "definition-hash",
    actionRefHash: "action-ref-hash",
    amount: 5,
    displayPayload: { title: "Ship package" },
    attribution: {},
    taskRef: { taskId: "task-1" },
    status: "pending",
    dispatchStatus: "blocked",
    dispatchAttemptCount: 0,
    dispatchClaimExpiresAt: null,
    idempotencyKey: "idem-1",
    failureReason: null,
    createdAt: now,
    expiresAt: now,
    decidedAt: null,
    settledAt: null,
    queuedAt: null,
    dispatchedAt: null,
    completedAt: null,
    updatedAt: now,
  };
}
