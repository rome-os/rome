import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppStartedEvent } from "@rome-os/app-runtime";
import type { ActionEngine } from "../actions/engine.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { RomeAppRuntimeServices } from "../apps/context.js";
import { packArtifact } from "../apps/packaging/index.js";
import type { ArtifactRef, ResolvedApp } from "../apps/state.js";
import { createTestApps } from "../apps/test-helpers.js";
import { createAppStartedDispatcher } from "./app-started.js";
import type { HookInvocationContext } from "./hook-recursion.js";
import { getCurrentHookInvocationContext, runWithHookInvocationContext } from "./hook-recursion.js";

interface StartedCall {
  appId: string;
  event: AppStartedEvent;
  hasAppContext: boolean;
}

type AppStartedGlobal = typeof globalThis & {
  __appStartedCalls?: StartedCall[];
  __appStartedContexts?: Array<HookInvocationContext | undefined>;
  __appStartedCaptureContext?: () => void;
  __appStartedRelease?: () => void;
  __appStartedRestart?: () => Promise<void>;
  __appStartedRestarted?: boolean;
  __appStartedLaterDone?: boolean;
  __appStartedSawLater?: boolean;
};

const testGlobal = globalThis as AppStartedGlobal;

describe("AppStartedDispatcher", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    delete testGlobal.__appStartedCalls;
    delete testGlobal.__appStartedContexts;
    delete testGlobal.__appStartedCaptureContext;
    delete testGlobal.__appStartedRelease;
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("loads hooks before open and calls each once open", async () => {
    const catalog = fakeCatalog([
      app("app.first", [await hookDir("first")]),
      app("app.second", [await hookDir("second")]),
    ]);
    const dispatcher = createDispatcher(catalog);

    expect(await dispatcher.reconcile(catalog)).toEqual([]);
    await flush();
    expect(calls()).toEqual([]);

    dispatcher.open(catalog);
    dispatcher.open(catalog);
    await flush();

    expect(calls()).toEqual([
      {
        appId: "app.first",
        event: { type: "app-started", version: 1, appId: "app.first", appVersion: "1.0.0" },
        hasAppContext: true,
      },
      {
        appId: "app.second",
        event: { type: "app-started", version: 1, appId: "app.second", appVersion: "1.0.0" },
        hasAppContext: true,
      },
    ]);
  });

  it("calls a hook whose app starts after open", async () => {
    const catalog = fakeCatalog([]);
    const dispatcher = createDispatcher(catalog);
    await dispatcher.reconcile(catalog);
    dispatcher.open(catalog);

    catalog.set([app("app.late", [await hookDir("late")])]);
    await settle(dispatcher, catalog);
    await flush();

    expect(calledAppIds()).toEqual(["app.late"]);
  });

  it("queues a hook until flush", async () => {
    const catalog = fakeCatalog([]);
    const dispatcher = createDispatcher(catalog);
    dispatcher.open(catalog);

    catalog.set([app("app.queued", [await hookDir("queued")])]);
    await dispatcher.reconcile(catalog);
    await flush();
    expect(calls()).toEqual([]);

    dispatcher.flush(catalog);
    await flush();
    expect(calledAppIds()).toEqual(["app.queued"]);
  });

  it("drops a queued hook whose app stops before the flush", async () => {
    const catalog = fakeCatalog([app("app.brief", [await hookDir("brief")])]);
    const dispatcher = createDispatcher(catalog);
    dispatcher.open(catalog);
    await dispatcher.reconcile(catalog);

    catalog.set([]);
    await settle(dispatcher, catalog);
    await flush();

    expect(calls()).toEqual([]);
  });

  it("keeps a queued start while its app is mid-install at open", async () => {
    const dir = await hookDir("reinstalling");
    const catalog = fakeCatalog([app("app.reinstalling", [dir])]);
    const dispatcher = createDispatcher(catalog);
    await dispatcher.reconcile(catalog);

    // An identical re-install began before open: the app shows `installing`.
    catalog.set([{ ...app("app.reinstalling", [dir]), state: "installing" }]);
    await dispatcher.reconcile(catalog);
    dispatcher.open(catalog);
    await flush();
    expect(calls()).toEqual([]);

    catalog.set([app("app.reinstalling", [dir])]);
    await settle(dispatcher, catalog);
    await flush();
    expect(calledAppIds()).toEqual(["app.reinstalling"]);
  });

  it("does not call again for the same bundle", async () => {
    const catalog = fakeCatalog([app("app.same", [await hookDir("same")])]);
    const dispatcher = createDispatcher(catalog);
    await dispatcher.reconcile(catalog);
    dispatcher.open(catalog);
    await flush();

    catalog.set([app("app.same", [await hookDir("same-reinstall")])]);
    await settle(dispatcher, catalog);
    await flush();

    expect(calledAppIds()).toEqual(["app.same"]);
  });

  it("calls again when an upgrade changes the bundle", async () => {
    const catalog = fakeCatalog([app("app.up", [await hookDir("up-v1")])]);
    const dispatcher = createDispatcher(catalog);
    await dispatcher.reconcile(catalog);
    dispatcher.open(catalog);
    await flush();

    catalog.set([app("app.up", [await hookDir("up-v2")], { hash: "2", version: "2.0.0" })]);
    await settle(dispatcher, catalog);
    await flush();

    expect(calls().map((call) => call.event.appVersion)).toEqual(["1.0.0", "2.0.0"]);
  });

  it("calls again when a disabled app is enabled", async () => {
    const dir = await hookDir("toggle");
    const catalog = fakeCatalog([app("app.toggle", [dir])]);
    const dispatcher = createDispatcher(catalog);
    await dispatcher.reconcile(catalog);
    dispatcher.open(catalog);
    await flush();

    catalog.set([]);
    await settle(dispatcher, catalog);
    catalog.set([app("app.toggle", [dir])]);
    await settle(dispatcher, catalog);
    await flush();

    expect(calledAppIds()).toEqual(["app.toggle", "app.toggle"]);
  });

  it("does not call a hook whose app is disabled before open", async () => {
    const catalog = fakeCatalog([app("app.gone", [await hookDir("gone")])]);
    const dispatcher = createDispatcher(catalog);
    await dispatcher.reconcile(catalog);

    catalog.set([]);
    await dispatcher.reconcile(catalog);
    dispatcher.open(catalog);
    await flush();

    expect(calls()).toEqual([]);
  });

  it("ignores hooks with other names", async () => {
    const dir = await hookDir("other");
    const catalog = fakeCatalog([app("app.other", [dir], { hookName: "agent-turn-finished" })]);
    const dispatcher = createDispatcher(catalog);

    expect(await dispatcher.reconcile(catalog)).toEqual([]);
    dispatcher.open(catalog);
    await flush();

    expect(calls()).toEqual([]);
  });

  it("keeps reporting a load failure until the app starts a new bundle", async () => {
    const invalid = await hookDir("invalid", "return { onAgentTurnFinished() {} };");
    const catalog = fakeCatalog([app("app.invalid", [invalid])]);
    const dispatcher = createDispatcher(catalog);

    const failure = {
      appId: "app.invalid",
      path: invalid,
      error: expect.stringContaining("must implement onAppStarted(event)"),
    };
    expect(await dispatcher.reconcile(catalog)).toEqual([failure]);
    expect(await dispatcher.reconcile(catalog)).toEqual([failure]);

    catalog.set([app("app.invalid", [await hookDir("fixed")], { hash: "2" })]);
    expect(await dispatcher.reconcile(catalog)).toEqual([]);
  });

  it("isolates a throwing hook from the other apps", async () => {
    const catalog = fakeCatalog([
      app("app.broken", [
        await hookDir("broken", "return { onAppStarted() { throw new Error('boom'); } };"),
      ]),
      app("app.healthy", [await hookDir("healthy")]),
    ]);
    const dispatcher = createDispatcher(catalog);

    expect(await dispatcher.reconcile(catalog)).toEqual([]);
    dispatcher.open(catalog);
    await flush();

    expect(calledAppIds()).toEqual(["app.healthy"]);
  });

  it("does not wait for a hook to finish", async () => {
    const catalog = fakeCatalog([
      app("app.slow", [
        await hookDir(
          "slow",
          `return {
    onAppStarted() {
      return new Promise((resolve) => {
        globalThis.__appStartedRelease = () => {
          globalThis.__appStartedCalls ??= [];
          globalThis.__appStartedCalls.push({ appId: deps.appId });
          resolve();
        };
      });
    },
  };`,
        ),
      ]),
    ]);
    const dispatcher = createDispatcher(catalog);
    await dispatcher.reconcile(catalog);
    dispatcher.open(catalog);
    await flush();

    expect(testGlobal.__appStartedRelease).toBeTypeOf("function");
    expect(calls()).toEqual([]);

    testGlobal.__appStartedRelease?.();
    expect(calledAppIds()).toEqual(["app.slow"]);
  });

  it("runs the hook as the app-started link of a hook chain", async () => {
    testGlobal.__appStartedCaptureContext = () => {
      testGlobal.__appStartedContexts ??= [];
      testGlobal.__appStartedContexts.push(getCurrentHookInvocationContext());
    };
    const catalog = fakeCatalog([
      app("app.chain", [
        await hookDir(
          "chain",
          "return { onAppStarted() { globalThis.__appStartedCaptureContext(); } };",
        ),
      ]),
    ]);
    const dispatcher = createDispatcher(catalog);
    await dispatcher.reconcile(catalog);
    dispatcher.open(catalog);
    await flush();

    expect(testGlobal.__appStartedContexts).toEqual([
      expect.objectContaining({
        depth: 1,
        chain: [{ hookType: "app", appId: "app.chain", hookName: "app-started" }],
      }),
    ]);
  });

  it("dispatches a start queued before open under the chain that caused it", async () => {
    testGlobal.__appStartedCaptureContext = () => {
      testGlobal.__appStartedContexts ??= [];
      testGlobal.__appStartedContexts.push(getCurrentHookInvocationContext());
    };
    const catalog = fakeCatalog([
      app("app.caused", [
        await hookDir(
          "caused",
          "return { onAppStarted() { globalThis.__appStartedCaptureContext(); } };",
        ),
      ]),
    ]);
    const dispatcher = createDispatcher(catalog);
    const cause: HookInvocationContext = {
      rootInvocationId: "root-cause",
      depth: 1,
      chain: [{ hookType: "lifecycle", appId: "app.other", hookName: "agent-turn-finished" }],
    };

    await runWithHookInvocationContext(cause, () => dispatcher.reconcile(catalog));
    dispatcher.open(catalog);
    await flush();

    expect(testGlobal.__appStartedContexts).toEqual([
      {
        rootInvocationId: "root-cause",
        depth: 2,
        chain: [...cause.chain, { hookType: "app", appId: "app.caused", hookName: "app-started" }],
      },
    ]);
  });

  async function hookDir(name: string, body?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `rome-app-started-${name}-`));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "index.js"),
      `
export function createHook(deps) {
  ${
    body ??
    `return {
    onAppStarted(event) {
      globalThis.__appStartedCalls ??= [];
      globalThis.__appStartedCalls.push({
        appId: deps.appId,
        event,
        hasAppContext: deps.appContext !== undefined,
      });
    },
  };`
  }
}
`,
      "utf-8",
    );
    return dir;
  }
});

describe("AppStartedDispatcher through the app manager", () => {
  afterEach(() => {
    delete testGlobal.__appStartedCalls;
  });

  it("starts once per bundle across install, re-install, upgrade, and re-enable", async () => {
    const harness = await createTestApps();
    try {
      wireLikeBoot(harness.catalog, createDispatcher(harness.catalog));
      const v1 = await packHookApp(harness.profileRoot, "v1", "0.0.1");
      const v2 = await packHookApp(harness.profileRoot, "v2", "0.0.2");

      await harness.appManager.install({ source: { mode: "bundle", path: v1 } });
      await flush();
      expect(calls().map((call) => call.event.appVersion)).toEqual(["0.0.1"]);

      // A re-install of identical content passes through the `installing`
      // overlay, which drops the app from the resolved set until it finishes.
      await harness.appManager.install({ source: { mode: "bundle", path: v1 } });
      await flush();
      expect(calls()).toHaveLength(1);

      await harness.appManager.install({ source: { mode: "bundle", path: v2 } });
      await flush();
      expect(calls().map((call) => call.event.appVersion)).toEqual(["0.0.1", "0.0.2"]);

      await harness.appManager.setEnabled("starter", false);
      await harness.appManager.setEnabled("starter", true);
      await flush();
      expect(calls().map((call) => call.event.appVersion)).toEqual(["0.0.1", "0.0.2", "0.0.2"]);
    } finally {
      await harness.cleanup();
    }
  });
  it("calls the hook only after every catalog subscriber has handled the event", async () => {
    const harness = await createTestApps();
    try {
      wireLikeBoot(harness.catalog, createDispatcher(harness.catalog));
      // Registered after the dispatcher, like `actionWorkerWarmPoolInvalidator`,
      // and slow, like a worker recycle.
      harness.catalog.subscribe(async function laterSubscriber(event) {
        if (event.current?.state !== "installed") return;
        await new Promise((resolve) => setTimeout(resolve, 20));
        testGlobal.__appStartedLaterDone = true;
      });
      const app = await packHookApp(
        harness.profileRoot,
        "ordered",
        "0.0.1",
        "globalThis.__appStartedSawLater = globalThis.__appStartedLaterDone === true;",
      );

      await harness.appManager.install({ source: { mode: "bundle", path: app } });
      await flush();

      expect(calls()).toHaveLength(1);
      expect(testGlobal.__appStartedSawLater).toBe(true);
    } finally {
      delete testGlobal.__appStartedLaterDone;
      delete testGlobal.__appStartedSawLater;
      await harness.cleanup();
    }
  });

  it("opens only after a catalog event in progress has settled", async () => {
    const harness = await createTestApps();
    try {
      const dispatcher = createDispatcher(harness.catalog);
      harness.catalog.subscribe(async function appStartedSubscriber() {
        await dispatcher.reconcile(harness.catalog);
      });
      harness.catalog.onSettled(function appStartedFlush() {
        dispatcher.flush(harness.catalog);
      });
      const queued = await packHookApp(
        harness.profileRoot,
        "queued",
        "0.0.1",
        "globalThis.__appStartedSawLater = globalThis.__appStartedLaterDone === true;",
      );
      await harness.appManager.install({ source: { mode: "bundle", path: queued } });

      // A request served before boot finishes: its event is mid-fan-out when
      // boot opens the dispatcher.
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached!: () => void;
      const blocked = new Promise<void>((resolve) => {
        reached = resolve;
      });
      harness.catalog.subscribe(async function blockedSubscriber(event) {
        if (event.appId !== "other" || event.current?.state !== "installed") return;
        reached();
        await released;
        testGlobal.__appStartedLaterDone = true;
      });
      const other = await packHookApp(harness.profileRoot, "other", "0.0.1", "", "other");
      const install = harness.appManager.install({ source: { mode: "bundle", path: other } });
      await blocked;

      const opening = harness.catalog.whenIdle(() => dispatcher.open(harness.catalog));
      await flush();
      expect(calls()).toEqual([]);

      release();
      await Promise.all([install, opening]);
      await flush();

      expect(calledAppIds().sort()).toEqual(["other", "starter"]);
      expect(testGlobal.__appStartedSawLater).toBe(true);
    } finally {
      delete testGlobal.__appStartedLaterDone;
      delete testGlobal.__appStartedSawLater;
      await harness.cleanup();
    }
  });

  it("stops a hook that restarts its own app at the recursion guard", async () => {
    const harness = await createTestApps();
    try {
      wireLikeBoot(harness.catalog, createDispatcher(harness.catalog));
      testGlobal.__appStartedRestart = async () => {
        await harness.appManager.setEnabled("starter", false);
        await harness.appManager.setEnabled("starter", true);
      };
      const looping = await packHookApp(
        harness.profileRoot,
        "looping",
        "0.0.1",
        "await globalThis.__appStartedRestart(); globalThis.__appStartedRestarted = true;",
      );

      await harness.appManager.install({ source: { mode: "bundle", path: looping } });
      await rs.waitFor(() => expect(testGlobal.__appStartedRestarted).toBe(true));
      await flush();

      expect(calls()).toHaveLength(1);
    } finally {
      delete testGlobal.__appStartedRestart;
      delete testGlobal.__appStartedRestarted;
      await harness.cleanup();
    }
  });
});

async function packHookApp(
  root: string,
  name: string,
  version: string,
  afterRecord = "",
  appId = "starter",
): Promise<string> {
  const workspace = join(root, `workspace-${name}`);
  await mkdir(join(workspace, "hooks", "app-started"), { recursive: true });
  await writeFile(
    join(workspace, "app.yaml"),
    `formatVersion: 1
id: ${appId}
version: ${version}
description: app-started fixture
agents: []
actions: []
skills: []
hooks:
  - hooks/app-started
`,
    "utf-8",
  );
  await writeFile(
    join(workspace, "hooks", "app-started", "index.js"),
    `export function createHook(deps) {
  return {
    async onAppStarted(event) {
      globalThis.__appStartedCalls ??= [];
      globalThis.__appStartedCalls.push({ appId: deps.appId, event, hasAppContext: true });
      ${afterRecord}
    },
  };
}
`,
    "utf-8",
  );
  return (await packArtifact(workspace, `${workspace}.packed`)).outDir;
}

// Production order: the dispatcher's catalog subscriber reconciles, then the
// catalog's settled listener flushes.
async function settle(
  dispatcher: ReturnType<typeof createDispatcher>,
  catalog: AppCatalog,
): Promise<void> {
  await dispatcher.reconcile(catalog);
  dispatcher.flush(catalog);
}

function wireLikeBoot(catalog: AppCatalog, dispatcher: ReturnType<typeof createDispatcher>): void {
  catalog.subscribe(async function appStartedSubscriber() {
    await dispatcher.reconcile(catalog);
  });
  catalog.onSettled(function appStartedFlush() {
    dispatcher.flush(catalog);
  });
  dispatcher.open(catalog);
}

function calls(): StartedCall[] {
  return testGlobal.__appStartedCalls ?? [];
}

function calledAppIds(): string[] {
  return calls().map((call) => call.appId);
}

// Hooks run on a later microtask than `open()` and `reconcile()`, after an
// awaited dynamic import, so let the queue drain twice.
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createDispatcher(catalog: AppCatalog) {
  return createAppStartedDispatcher({ appRuntimeServices: runtimeServices(catalog) });
}

function runtimeServices(catalog: AppCatalog): RomeAppRuntimeServices {
  return {
    catalog,
    db: {} as RomeAppRuntimeServices["db"],
    actionEngine: {} as ActionEngine,
    repositories: {
      settings: {
        get: async () => null,
        set: async () => undefined,
      },
    },
  };
}

type FakeCatalog = AppCatalog & { set(apps: ResolvedApp[]): void };

function fakeCatalog(initial: ResolvedApp[]): FakeCatalog {
  let apps = initial;
  return {
    set(next: ResolvedApp[]) {
      apps = next;
    },
    get(appId: string) {
      return apps.find((candidate) => candidate.appId === appId) ?? null;
    },
    listResolved() {
      return apps.filter((candidate) => candidate.state === "installed" && candidate.enabled);
    },
  } as unknown as FakeCatalog;
}

function app(
  appId: string,
  hookDirs: string[],
  options: { hash?: string; version?: string; hookName?: string } = {},
): ResolvedApp {
  const version = options.version ?? "1.0.0";
  const hooks: ArtifactRef[] = hookDirs.map((absolutePath) => ({
    kind: "hook",
    publicName: options.hookName ?? "app-started",
    aliases: [],
    ownerType: "app",
    ownerId: appId,
    absolutePath,
  }));
  return {
    appId,
    state: "installed",
    enabled: true,
    firstParty: false,
    source: { mode: "bundle", path: "/tmp/app" },
    installedHash: (options.hash ?? "1").repeat(64),
    installedVersion: version,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    manifest: {
      id: appId,
      version,
      description: "App-started test app",
      agents: [],
      actions: [],
      skills: [],
      hooks: [],
    },
    rootPath: "/tmp/app",
    resolveRoot: "/tmp/app",
    displayName: appId,
    iconAbsolutePath: undefined,
    artifacts: { agent: [], action: [], skill: [], hook: hooks },
    web: null,
    api: null,
    db: null,
  };
}
