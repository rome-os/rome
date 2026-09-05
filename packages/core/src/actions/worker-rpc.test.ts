import { EventEmitter } from "node:events";
import { AsyncResource } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { describe, it, expect, rs } from "@rstest/core";
import { WorkerRpcServer, type WorkerRpcServices } from "./worker-rpc.js";
import { ActionEngine } from "./engine.js";
import { replayContext, type ReplayStore } from "./replay.js";
import { ActionRegistryImpl } from "./registry.js";
import { EventBus, type BusEvent } from "../events/event-bus.js";
import { EventCatalog } from "../event-catalog.js";
import { EventService } from "../events/event-service.js";
import { AppLifecycleService } from "../apps/lifecycle-service.js";
import { buildAction } from "../test/kit/index.js";
import type { ActionResult } from "./types.js";

interface SubprocessEngine {
  executeInSubprocess(...args: unknown[]): Promise<ActionResult>;
}

// A fake IPC peer standing in for the worker ChildProcess: it records every
// message the server sends back so tests can assert on the rpc_response.
interface RpcResponse {
  type: "rpc_response";
  clientId: string;
  id: number;
  result?: unknown;
  error?: string;
}

function makeFakeWorker() {
  const emitter = new EventEmitter();
  const sent: RpcResponse[] = [];
  const worker = Object.assign(emitter, {
    connected: true,
    send: (message: RpcResponse, cb?: (err: Error | null) => void) => {
      sent.push(message);
      cb?.(null);
      return true;
    },
  });
  return { worker: worker as unknown as ChildProcess, emitter, sent };
}

let nextId = 1;

async function rpc(
  fake: ReturnType<typeof makeFakeWorker>,
  method: string,
  params: unknown,
): Promise<RpcResponse> {
  const id = nextId++;
  fake.emitter.emit("message", { type: "rpc_request", clientId: "client-1", id, method, params });
  return await rs.waitFor(() => {
    const response = fake.sent.find((m) => m.id === id);
    if (!response) throw new Error("no response yet");
    return response;
  });
}

// The RPC server now only validates wire params and delegates to the
// coordinators, so we wire it with the *real* EventService / AppLifecycleService
// over real bus+catalog and a faked AppManager. Tests then assert on the
// observable effect (the bus received the event, the catalog surfaces it, the
// AppManager was driven) rather than on the handler internals.
function makeServer(
  overrides: {
    routinesRepo?: unknown;
    eventBus?: EventBus;
    eventCatalog?: EventCatalog;
    appManager?: { setEnabled: ReturnType<typeof rs.fn>; install?: ReturnType<typeof rs.fn> };
    appStore?: {
      listListings: ReturnType<typeof rs.fn>;
      getListing: ReturnType<typeof rs.fn>;
    };
    hasRegisteredAction?: ReturnType<typeof rs.fn>;
    childSessions?: {
      startDetached: ReturnType<typeof rs.fn>;
      getStatus: ReturnType<typeof rs.fn>;
      stop: ReturnType<typeof rs.fn>;
    };
    notify?: { send: ReturnType<typeof rs.fn> };
    talkRouter?: { list: ReturnType<typeof rs.fn> };
  } = {},
) {
  const eventBus = overrides.eventBus ?? new EventBus();
  const eventCatalog = overrides.eventCatalog ?? new EventCatalog();
  const appManager = overrides.appManager ?? { setEnabled: rs.fn(async () => {}) };
  const appStore = overrides.appStore ?? {
    listListings: rs.fn(async () => ({
      status: 200,
      body: { available: true, browseOrigin: "https://store.example", listings: [] },
    })),
    getListing: rs.fn(async () => ({
      status: 200,
      body: { available: true, browseOrigin: "https://store.example" },
    })),
  };
  const routineEngine = { activate: rs.fn(async () => {}), deactivate: rs.fn() };
  const services = {
    routineEngine,
    routinesRepo: overrides.routinesRepo,
    eventService: new EventService(eventBus, eventCatalog),
    // catalog/db are only touched by uninstall --purge, which these tests don't
    // exercise, so stub them.
    appLifecycle: new AppLifecycleService(appManager as never, {} as never, {} as never),
    appStore,
    hasAgent: () => false,
    hasRegisteredAction: overrides.hasRegisteredAction ?? rs.fn(() => false),
    hasAction: () => false,
    systemUpgrade: { checkAndOffer: rs.fn() },
    backendTurnRunner: { runAndDeliver: rs.fn() },
    childSessions: overrides.childSessions ?? {
      startDetached: rs.fn(),
      getStatus: rs.fn(),
      stop: rs.fn(),
    },
    notify: overrides.notify ?? { send: rs.fn() },
    talkRouter: overrides.talkRouter,
  } as unknown as WorkerRpcServices;
  return {
    server: new WorkerRpcServer(services),
    services,
    eventBus,
    eventCatalog,
    appManager,
    appStore,
    routineEngine,
    childSessions: services.childSessions,
  };
}

describe("WorkerRpcServer param validation", () => {
  it("forwards a pinned Store source to create without an install call", async () => {
    const install = rs.fn();
    const { server, services } = makeServer({ appManager: { setEnabled: rs.fn(), install } });
    const create = rs.spyOn(services.appLifecycle, "create").mockResolvedValue({} as never);
    const fake = makeFakeWorker();
    server.attach(fake.worker);
    const params = {
      appId: "ray-calendar",
      name: "@ray/calendar",
      from: { listingId: "@alice/calendar", version: "1.0.0", contentHash: "a".repeat(64) },
    };
    expect((await rpc(fake, "apps.create", params)).error).toBeUndefined();
    expect(create).toHaveBeenCalledWith(params);
    expect(install).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { appId: "" },
    { appId: "calendar", listingId: "calendar", version: "1.0.0", contentHash: "a".repeat(64) },
    { listingId: "calendar", version: "1.0.0" },
    { listingId: "calendar", version: "latest", contentHash: "a".repeat(64) },
    { listingId: "https://attacker.example/app", version: "1.0.0", contentHash: "a".repeat(64) },
    { listingId: "calendar", version: "1.0.0", contentHash: "invalid" },
    { appId: "calendar", expectedSource: null },
    { appId: "calendar", expectedSource: { listingId: "calendar", version: "1.0.0" } },
    { appId: "calendar", prompt: "untrusted instructions" },
  ])("rejects a mixed or unpinned Remix source %#", async (from) => {
    const { server, services } = makeServer();
    const create = rs.spyOn(services.appLifecycle, "create");
    const fake = makeFakeWorker();
    server.attach(fake.worker);
    expect(
      (await rpc(fake, "apps.create", { appId: "ray-calendar", name: "@ray/calendar", from }))
        .error,
    ).toMatch(/invalid params/);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([false, true])("normalizes the confirmed hash for installed=%s", async (installed) => {
    const { server, services } = makeServer();
    const create = rs.spyOn(services.appLifecycle, "create").mockResolvedValue({} as never);
    const fake = makeFakeWorker();
    server.attach(fake.worker);
    const pin = { listingId: "@alice/calendar", version: "1.0.0", contentHash: "A".repeat(64) };
    const from = installed ? { appId: pin.listingId, expectedSource: pin } : pin;
    const params = { appId: "ray-calendar", name: "@ray/calendar", from };

    expect((await rpc(fake, "apps.create", params)).error).toBeUndefined();
    const normalized = { ...pin, contentHash: "a".repeat(64) };
    expect(create).toHaveBeenCalledWith({
      ...params,
      from: installed ? { appId: pin.listingId, expectedSource: normalized } : normalized,
    });
  });

  it("preserves a canonical Remix source and expected pin across RPC", async () => {
    const { server, services } = makeServer();
    const create = rs.spyOn(services.appLifecycle, "create").mockResolvedValue({} as never);
    const fake = makeFakeWorker();
    server.attach(fake.worker);
    const params = {
      appId: "ray-calendar",
      name: "@ray/calendar",
      from: {
        appId: "@alice/calendar",
        expectedSource: {
          listingId: "@alice/calendar",
          version: "1.0.0",
          contentHash: "a".repeat(64),
        },
      },
    };
    expect((await rpc(fake, "apps.create", params)).error).toBeUndefined();
    expect(create).toHaveBeenCalledWith(params);
  });
  it("rejects a mixed template/remix create shape at the RPC boundary", async () => {
    const { server } = makeServer({});
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "apps.create", {
      appId: "ray-calendar",
      rootPath: "/projects/apps/ray-calendar",
      template: "default",
      name: "@ray/calendar",
      from: { appId: "calendar" },
    });

    expect(response.result).toBeUndefined();
    expect(response.error).toMatch(/apps\.create: invalid params/);
  });

  it("serves the current main-process Talk connection list", async () => {
    const list = rs
      .fn()
      .mockResolvedValueOnce([{ connectionId: "discord-1", service: "discord" }])
      .mockResolvedValueOnce([{ connectionId: "wechat-1", service: "wechat" }]);
    const { server } = makeServer({ talkRouter: { list } });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const first = await rpc(fake, "talk.list", {});
    const second = await rpc(fake, "talk.list", {});

    expect(first.result).toEqual([{ connectionId: "discord-1", service: "discord" }]);
    expect(second.result).toEqual([{ connectionId: "wechat-1", service: "wechat" }]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("enables an app and echoes the result when params are valid", async () => {
    const { server, appManager } = makeServer({});
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "apps.setEnabled", { appId: "demo", enabled: false });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ appId: "demo", enabled: false });
    expect(appManager.setEnabled).toHaveBeenCalledWith("demo", false);
  });

  it("rejects apps.setEnabled when enabled is missing without touching the service", async () => {
    const { server, appManager } = makeServer({});
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "apps.setEnabled", { appId: "demo" });

    expect(response.result).toBeUndefined();
    expect(response.error).toContain("apps.setEnabled: invalid params");
    expect(appManager.setEnabled).not.toHaveBeenCalled();
  });

  it("rejects apps.setEnabled when enabled is not a boolean", async () => {
    const { server, appManager } = makeServer({});
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "apps.setEnabled", { appId: "demo", enabled: "yes" });

    expect(response.error).toContain("invalid params");
    expect(appManager.setEnabled).not.toHaveBeenCalled();
  });

  it("forwards the exact AgentSession identity for session.continue", async () => {
    const { server, services } = makeServer({});
    const fake = makeFakeWorker();
    server.attach(fake.worker);
    const params = {
      agentName: "main",
      sessionId: "agent-session-1",
      channel: "webchat",
      threadId: "sess-1",
      prompt: "continue",
    };

    const response = await rpc(fake, "session.continue", params);

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ ok: true });
    expect(services.backendTurnRunner.runAndDeliver).toHaveBeenCalledWith(params);
  });

  it("rejects session.continue without the exact AgentSession identity", async () => {
    const { server, services } = makeServer({});
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "session.continue", {
      agentName: "main",
      channel: "webchat",
      threadId: "sess-1",
      prompt: "continue",
    });

    expect(response.error).toContain("session.continue: invalid params");
    expect(services.backendTurnRunner.runAndDeliver).not.toHaveBeenCalled();
  });

  it("answers actions.has from the main action registry", async () => {
    const hasRegisteredAction = rs.fn((name: string) => name === "send_message");
    const { server } = makeServer({ hasRegisteredAction });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "actions.has", { actionName: "send_message" });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ hasAction: true });
    expect(hasRegisteredAction).toHaveBeenCalledWith("send_message");
  });

  it("forwards appStore.listListings when params are valid", async () => {
    const { server, appStore } = makeServer({});
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "appStore.listListings", {
      query: "calendar",
      limit: 5,
      includeInstalledState: true,
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ status: 200 });
    expect(appStore.listListings).toHaveBeenCalledWith({
      query: "calendar",
      limit: 5,
      includeInstalledState: true,
    });
  });

  it("rejects appStore.listListings when limit is invalid", async () => {
    const { server, appStore } = makeServer({});
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "appStore.listListings", { limit: 0 });

    expect(response.result).toBeUndefined();
    expect(response.error).toContain("appStore.listListings: invalid params");
    expect(appStore.listListings).not.toHaveBeenCalled();
  });

  it("rejects routines.cancel with an empty routineId without deactivating anything", async () => {
    const { server, services } = makeServer({});
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "routines.cancel", { routineId: "" });

    expect(response.error).toContain("routines.cancel: invalid params");
    expect(services.routineEngine.deactivate).not.toHaveBeenCalled();
  });

  it("deactivates a routine when routineId is valid", async () => {
    const { server, services } = makeServer({});
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "routines.cancel", { routineId: "r-42" });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ ok: true });
    expect(services.routineEngine.deactivate).toHaveBeenCalledWith("r-42");
  });
});

describe("WorkerRpcServer routines.schedule", () => {
  const baseRow = {
    id: "r-7",
    name: "daily-check",
    enabled: true,
    trigger: { type: "schedule", tzid: "UTC", localTime: "09:00", rrule: "FREQ=DAILY" },
    actionName: "do_thing",
    args: {},
    createdAt: new Date(),
    lastFiredAt: null,
    nextRunAt: null,
  };

  it("activates an enabled routine and acks", async () => {
    const { server, services } = makeServer({
      routinesRepo: { findById: rs.fn(async () => baseRow) },
    });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "routines.schedule", { routineId: "r-7" });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ ok: true });
    expect(services.routineEngine.activate).toHaveBeenCalledTimes(1);
    expect(services.routineEngine.deactivate).not.toHaveBeenCalled();
  });

  it("deactivates a disabled routine instead of activating it", async () => {
    const { server, services } = makeServer({
      routinesRepo: { findById: rs.fn(async () => ({ ...baseRow, enabled: false })) },
    });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "routines.schedule", { routineId: "r-7" });

    expect(response.result).toEqual({ ok: true });
    expect(services.routineEngine.deactivate).toHaveBeenCalledWith("r-7");
    expect(services.routineEngine.activate).not.toHaveBeenCalled();
  });

  it("errors when the routine is not found and touches neither engine path", async () => {
    const { server, services } = makeServer({
      routinesRepo: { findById: rs.fn(async () => undefined) },
    });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "routines.schedule", { routineId: "ghost" });

    expect(response.result).toBeUndefined();
    expect(response.error).toContain("Routine not found");
    expect(services.routineEngine.activate).not.toHaveBeenCalled();
    expect(services.routineEngine.deactivate).not.toHaveBeenCalled();
  });

  it("rejects routines.schedule with an empty routineId without reading the repo", async () => {
    const findById = rs.fn();
    const { server } = makeServer({
      routinesRepo: { findById },
    });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "routines.schedule", { routineId: "" });

    expect(response.error).toContain("routines.schedule: invalid params");
    expect(findById).not.toHaveBeenCalled();
  });
});

describe("WorkerRpcServer events.publish", () => {
  it("publishes a well-formed BusEvent and acks", async () => {
    const bus = new EventBus();
    const received: BusEvent[] = [];
    bus.subscribe((e) => received.push(e));
    const { server } = makeServer({ eventBus: bus });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "events.publish", {
      name: "order.created",
      source: "connector",
      payload: { orderId: 1 },
    });

    expect(received).toHaveLength(1);
    expect(received[0].name).toBe("order.created");
    expect(received[0].source).toBe("connector");
    expect(received[0].payload).toEqual({ orderId: 1 });
    expect(typeof received[0].emittedAt).toBe("string");
    expect(response.result).toEqual({ accepted: true });
    expect(response.error).toBeUndefined();
  });

  it("defaults payload to an empty object when omitted", async () => {
    const bus = new EventBus();
    const received: BusEvent[] = [];
    bus.subscribe((e) => received.push(e));
    const { server } = makeServer({ eventBus: bus });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    await rpc(fake, "events.publish", { name: "ping", source: "sys" });

    expect(received[0].payload).toEqual({});
  });

  it("rejects a publish missing name or source and emits nothing", async () => {
    const bus = new EventBus();
    let published = 0;
    bus.subscribe(() => published++);
    const { server } = makeServer({ eventBus: bus });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const missingName = await rpc(fake, "events.publish", { source: "sys" });
    const missingSource = await rpc(fake, "events.publish", { name: "x" });

    expect(published).toBe(0);
    expect(missingName.error).toContain("events.publish: invalid params");
    expect(missingName.error).toContain("name");
    expect(missingSource.error).toContain("events.publish: invalid params");
    expect(missingSource.error).toContain("source");
  });

  it("starts event-triggered actions outside the pooled worker's stale replay context", async () => {
    const bus = new EventBus();
    const { server } = makeServer({ eventBus: bus });
    const fake = makeFakeWorker();
    const registry = new ActionRegistryImpl([]);
    registry.register(buildAction("routine_action"));
    const actionEngine = new ActionEngine(registry, undefined, undefined, undefined, undefined, {
      processRole: "main",
    });
    const executeInSubprocess = rs
      .spyOn(actionEngine as unknown as SubprocessEngine, "executeInSubprocess")
      .mockResolvedValue({ status: "ok" });
    let routineRun: Promise<unknown> | undefined;
    let observedReplayRoot: string | undefined;
    bus.subscribe(() => {
      observedReplayRoot = replayContext.getStore()?.rootExecutionId;
      routineRun = actionEngine.run("routine_action", {}, { rootExecutionId: "fresh-root" });
    });

    const staleStore: ReplayStore = {
      rootExecutionId: "stale-root",
      rootActionName: "unrelated_action",
      rootArgs: {},
      journal: [],
      nextSequence: 0,
      replayIndex: 0,
      mode: "record",
      divergenceMode: "fallthrough",
    };
    let pooledWorkerResource!: AsyncResource;
    replayContext.run(staleStore, () => {
      // ChildProcess IPC callbacks run under the async resource created by
      // fork(). Model that resource explicitly so this test is deterministic
      // without starting a real worker process.
      pooledWorkerResource = new AsyncResource("pooled-worker-ipc");
      server.attach(fake.worker);
    });

    const id = nextId++;
    pooledWorkerResource.runInAsyncScope(() => {
      fake.emitter.emit("message", {
        type: "rpc_request",
        clientId: "client-1",
        id,
        method: "events.publish",
        params: { name: "github.pull_request", source: "connector", payload: {} },
      });
    });
    await rs.waitFor(() => expect(fake.sent.some((message) => message.id === id)).toBe(true));
    await rs.waitFor(() => expect(routineRun).toBeDefined());
    await routineRun;
    pooledWorkerResource.emitDestroy();

    expect(observedReplayRoot).toBeUndefined();
    expect(executeInSubprocess).toHaveBeenCalledTimes(1);
    expect(executeInSubprocess.mock.calls[0][0]).toMatchObject({
      rootExecutionId: "fresh-root",
      isRoot: true,
    });
  });
});

describe("WorkerRpcServer event discovery", () => {
  it("registers an event type on publish and surfaces it via events.searchCatalog", async () => {
    const bus = new EventBus();
    const catalog = new EventCatalog();
    const { server } = makeServer({ eventBus: bus, eventCatalog: catalog });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const empty = await rpc(fake, "events.searchCatalog", { query: "gmail" });
    expect(empty.result).toEqual({ entries: [], total: 0 });

    const publish = await rpc(fake, "events.publish", {
      name: "provider:event:gmail.gmail_new_gmail_message",
      source: "connector",
      payload: { from: { email: "dana@example.com" } },
    });
    expect(publish.result).toEqual({ accepted: true });

    // The published payload's inferred JSON Schema rides back through the
    // catalog so a consumer can see which fields a routine trigger.filter
    // could match — including nested ones (filter fields are dot-paths).
    const found = await rpc(fake, "events.searchCatalog", { query: "gmail", limit: 5 });
    expect(found.result).toEqual({
      entries: [
        {
          eventType: "provider:event:gmail.gmail_new_gmail_message",
          appId: "connector",
          payloadSchema: {
            type: "object",
            properties: {
              from: { type: "object", properties: { email: { type: "string" } } },
            },
          },
          schemaOrigin: "observed",
        },
      ],
      total: 1,
    });
  });

  it("rejects events.searchCatalog with a non-positive limit", async () => {
    const catalog = new EventCatalog();
    const { server } = makeServer({ eventBus: new EventBus(), eventCatalog: catalog });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "events.searchCatalog", { query: "x", limit: 0 });

    expect(response.result).toBeUndefined();
    expect(response.error).toContain("events.searchCatalog: invalid params");
  });

  it("does not fail a publish when a colliding event type is already owned by another app", async () => {
    const bus = new EventBus();
    const catalog = new EventCatalog();
    catalog.register({ eventType: "order.created", appId: "shop" });
    let published = 0;
    bus.subscribe(() => published++);
    const { server } = makeServer({ eventBus: bus, eventCatalog: catalog });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    // A different source claims the same type — registration is skipped, but the
    // event still publishes (publishing must never break on catalog drift).
    const response = await rpc(fake, "events.publish", {
      name: "order.created",
      source: "other-app",
      payload: {},
    });

    expect(response.result).toEqual({ accepted: true });
    expect(published).toBe(1);
    expect(catalog.get("order.created")?.appId).toBe("shop");
  });
});

describe("notify.send dispatch", () => {
  it("dispatches notify.send to the notify service and echoes the SendOutcome", async () => {
    const send = rs.fn(async () => ({ kind: "ok", attempted: 1, sent: 1, failed: 0 }));
    const { server } = makeServer({ notify: { send } });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "notify.send", {});

    expect(send).toHaveBeenCalledOnce();
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ kind: "ok", attempted: 1, sent: 1, failed: 0 });
  });

  it.each([
    ["a custom body", { body: "Build failed" }, { body: "Build failed" }],
    ["an empty-string body", { body: "" }, { body: "" }],
    ["no body ({})", {}, undefined],
  ])("parses %s and forwards it to notify.send", async (_label, params, expectedArg) => {
    const send = rs.fn(async () => ({ kind: "ok", attempted: 1, sent: 1, failed: 0 }));
    const { server } = makeServer({ notify: { send } });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "notify.send", params);

    expect(response.error).toBeUndefined();
    expect(send).toHaveBeenCalledWith(expectedArg);
  });

  it("rejects a non-string body without calling the notify service", async () => {
    const send = rs.fn(async () => ({ kind: "ok", attempted: 1, sent: 1, failed: 0 }));
    const { server } = makeServer({ notify: { send } });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "notify.send", { body: 123 });

    expect(response.error).toBeDefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an unknown extra param without calling the notify service (strict schema)", async () => {
    // The wire schema is strict: the sole caller is NotifyServiceProxy, which can
    // only emit {} or {body}, so an unknown key means a bug or a typo (e.g.
    // `bodu`) — surface it as an error rather than silently dropping it and
    // sending the default alert.
    const send = rs.fn(async () => ({ kind: "ok", attempted: 1, sent: 1, failed: 0 }));
    const { server } = makeServer({ notify: { send } });
    const fake = makeFakeWorker();
    server.attach(fake.worker);

    const response = await rpc(fake, "notify.send", { body: "hi", title: "sneaky" });

    expect(response.error).toBeDefined();
    expect(send).not.toHaveBeenCalled();
  });

  // Cancellation terminates the action worker, but the already
  // dispatched main-side request may still complete. The engine must not retry
  // that ambiguous request, and the RPC server must drop its orphaned reply.
  it("completes an in-flight notify request once after ActionEngine cancellation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let completed = false;
    const send = rs.fn(async () => {
      await gate; // block until the test releases (i.e. past the disconnect)
      completed = true; // main-side work completes despite the worker being gone
      return { kind: "ok", attempted: 1, sent: 1, failed: 0 };
    });
    const { server } = makeServer({ notify: { send } });
    class NotifyWorker extends EventEmitter {
      pid: number | undefined = 789_012;
      connected = true;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      sent: unknown[] = [];

      send(message: unknown, callback?: (error: Error | null) => void): boolean {
        this.sent.push(message);
        callback?.(null);
        if ((message as { actionName?: string }).actionName === "send_notification") {
          queueMicrotask(() => {
            this.emit("message", {
              type: "rpc_request",
              clientId: "client-1",
              id: 999,
              method: "notify.send",
              params: {},
            });
          });
        }
        return true;
      }
    }

    const worker = new NotifyWorker();
    const disconnected = rs.fn();
    const exited = rs.fn();
    worker.on("disconnect", disconnected);
    worker.on("exit", exited);
    const registry = new ActionRegistryImpl([]);
    registry.register(buildAction("send_notification"));
    const engine = new ActionEngine(registry, undefined, undefined, undefined, undefined, {
      processRole: "main",
      workerWarmPoolSize: 0,
      actionWorkerFork: () => worker as unknown as ChildProcess,
    });
    engine.setWorkerRpcServer(server);
    const kill = rs.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -789_012 && signal === "SIGTERM") {
        worker.connected = false;
        worker.signalCode = "SIGTERM";
        worker.pid = undefined;
        queueMicrotask(() => {
          worker.emit("disconnect");
          worker.emit("exit", null, "SIGTERM");
        });
      }
      return true;
    });

    try {
      const run = engine.run("send_notification", {}, { executionId: "notify-cancel-root" });
      await rs.waitFor(() => expect(send).toHaveBeenCalledOnce());

      await expect(engine.cancel("notify-cancel-root")).resolves.toBe(true);
      await expect(run).rejects.toMatchObject({ name: "ActionCancelledError" });

      release();
      await rs.waitFor(() => expect(completed).toBe(true));

      expect(kill).toHaveBeenCalledWith(-789_012, "SIGTERM");
      expect(disconnected).toHaveBeenCalledOnce();
      expect(exited).toHaveBeenCalledWith(null, "SIGTERM");
      expect(send).toHaveBeenCalledOnce();
      expect(
        worker.sent.filter((message) => (message as { type?: string }).type === "rpc_response"),
      ).toHaveLength(0);
    } finally {
      release();
      kill.mockRestore();
    }
  });
});

describe("childSessions dispatch", () => {
  const started = {
    sessionId: "child-1",
    turnId: "child-turn-1",
    agentName: "coder",
    parentSessionId: "parent-1",
  };
  const parent = {
    parentSessionId: "parent-1",
    parentTurnId: "parent-turn-1",
    parentAgentName: "main",
  };
  const caller = { romeSessionId: "tick-2", agentName: "engineer:engineer" };

  function serverWithChildSessions() {
    const childSessions = {
      startDetached: rs.fn(async () => started),
      getStatus: rs.fn(async () => null),
      stop: rs.fn(async () => ({ stopped: true, status: "running" })),
    };
    const { server } = makeServer({ childSessions });
    const fake = makeFakeWorker();
    server.attach(fake.worker);
    return { fake, childSessions };
  }

  it("forwards a detached start with its parent identity", async () => {
    const { fake, childSessions } = serverWithChildSessions();

    const response = await rpc(fake, "childSessions.startDetached", {
      agentName: "coder",
      prompt: "land the migration",
      resumeSessionId: "child-1",
      workingDir: "/srv/clones/rome",
      parent,
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(started);
    expect(childSessions.startDetached).toHaveBeenCalledWith({
      agentName: "coder",
      prompt: "land the migration",
      resumeSessionId: "child-1",
      workingDir: "/srv/clones/rome",
      parent,
    });
  });

  it.each([
    ["no parent", { agentName: "coder", prompt: "go" }],
    ["a partial parent", { agentName: "coder", prompt: "go", parent: { parentSessionId: "p" } }],
    ["an empty prompt", { agentName: "coder", prompt: "", parent }],
    ["no agent", { prompt: "go", parent }],
  ])("rejects a start with %s", async (_label, params) => {
    // A detached child that arrives without a parent is unreachable from every
    // later turn, so the wire contract refuses it rather than filing an orphan.
    const { fake, childSessions } = serverWithChildSessions();

    const response = await rpc(fake, "childSessions.startDetached", params);

    expect(response.error).toMatch(/invalid params/);
    expect(childSessions.startDetached).not.toHaveBeenCalled();
  });

  it("forwards a status read and passes a missing session through as null", async () => {
    const { fake, childSessions } = serverWithChildSessions();

    const response = await rpc(fake, "childSessions.getStatus", {
      sessionId: "child-1",
      transcriptTail: 5,
      caller,
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toBeNull();
    expect(childSessions.getStatus).toHaveBeenCalledWith({
      sessionId: "child-1",
      transcriptTail: 5,
      caller,
    });
  });

  it("clamps an over-large transcript tail instead of refusing it", async () => {
    // Asking for more transcript than exists is not a caller error, and main
    // applies the same ceiling.
    const { fake, childSessions } = serverWithChildSessions();

    const response = await rpc(fake, "childSessions.getStatus", {
      sessionId: "child-1",
      transcriptTail: 9999,
      caller,
    });

    expect(response.error).toBeUndefined();
    expect(childSessions.getStatus).toHaveBeenCalledWith({
      sessionId: "child-1",
      transcriptTail: 50,
      caller,
    });
  });

  it.each([
    ["a fractional tail", { sessionId: "child-1", transcriptTail: 1.5, caller }],
    ["a negative tail", { sessionId: "child-1", transcriptTail: -1, caller }],
    ["an empty session id", { sessionId: "", caller }],
    ["no caller", { sessionId: "child-1" }],
  ])("rejects a status read with %s", async (_label, params) => {
    const { fake, childSessions } = serverWithChildSessions();

    const response = await rpc(fake, "childSessions.getStatus", params);

    expect(response.error).toMatch(/invalid params/);
    expect(childSessions.getStatus).not.toHaveBeenCalled();
  });

  it("forwards a stop with its caller identity", async () => {
    const { fake, childSessions } = serverWithChildSessions();

    const response = await rpc(fake, "childSessions.stop", { sessionId: "child-1", caller });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ stopped: true, status: "running" });
    expect(childSessions.stop).toHaveBeenCalledWith({ sessionId: "child-1", caller });
  });

  it("rejects a stop that names no caller", async () => {
    const { fake, childSessions } = serverWithChildSessions();

    const response = await rpc(fake, "childSessions.stop", { sessionId: "child-1" });

    expect(response.error).toMatch(/invalid params/);
    expect(childSessions.stop).not.toHaveBeenCalled();
  });
});
