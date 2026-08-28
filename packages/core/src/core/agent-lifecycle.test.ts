import { afterEach, describe, expect, it } from "@rstest/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentLifecycleDispatcher } from "./agent-lifecycle.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { ArtifactRef, ResolvedApp } from "../apps/state.js";
import type { AgentTurnFinishedEvent } from "@rome-os/app-runtime";
import type { RomeAppRuntimeServices } from "../apps/context.js";
import type { ActionEngine } from "../actions/engine.js";
import { getCurrentHookInvocationContext } from "./hook-recursion.js";

type LifecycleHookGlobal = typeof globalThis & {
  __agentLifecycleHookEvents?: Array<{ appId: string; event: AgentTurnFinishedEvent }>;
  __agentLifecycleHookDeps?: Array<{ appId: string; repositories: unknown }>;
  __agentLifecycleHookContexts?: Array<{
    appId: string;
    context: ReturnType<typeof getCurrentHookInvocationContext>;
  }>;
  __agentLifecycleCaptureHookContext?: (appId: string) => void;
  __agentLifecycleListenerContext?: ReturnType<typeof getCurrentHookInvocationContext>;
  __agentLifecycleNestedDispatcher?: ReturnType<typeof createAgentLifecycleDispatcher>;
  __agentLifecycleHookDispatchResults?: Array<
    ReturnType<ReturnType<typeof createAgentLifecycleDispatcher>["dispatchFinished"]>
  >;
};

describe("AgentLifecycleDispatcher", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    delete (globalThis as LifecycleHookGlobal).__agentLifecycleHookEvents;
    delete (globalThis as LifecycleHookGlobal).__agentLifecycleHookDeps;
    delete (globalThis as LifecycleHookGlobal).__agentLifecycleHookContexts;
    delete (globalThis as LifecycleHookGlobal).__agentLifecycleCaptureHookContext;
    delete (globalThis as LifecycleHookGlobal).__agentLifecycleListenerContext;
    delete (globalThis as LifecycleHookGlobal).__agentLifecycleNestedDispatcher;
    delete (globalThis as LifecycleHookGlobal).__agentLifecycleHookDispatchResults;
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("loads every matching lifecycle hook and fans out without blocking", async () => {
    const first = await createHookDir("first");
    const second = await createHookDir("second");
    const dispatcher = createAgentLifecycleDispatcher();
    const failures = await dispatcher.loadFromCatalog(
      catalogWithHooks([
        hookRef("app.first", "agent-turn-finished", first),
        hookRef("app.second", "agent-turn-finished", second),
      ]),
    );

    expect(failures).toEqual([]);

    const event = finishedEvent();
    dispatcher.dispatchFinished(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((globalThis as LifecycleHookGlobal).__agentLifecycleHookEvents).toEqual([
      { appId: "app.first", event },
      { appId: "app.second", event },
    ]);
  });

  it("isolates lifecycle payload mutations between app hooks", async () => {
    const mutator = await createHookDir(
      "mutator",
      `
  return {
    onAgentTurnFinished(event) {
      event.turn.agentName = "mutated-by-first-hook";
      event.metrics.toolCallCount = 999;
    },
  };
  `,
    );
    const observer = await createHookDir("observer");
    const dispatcher = createAgentLifecycleDispatcher();
    const failures = await dispatcher.loadFromCatalog(
      catalogWithHooks([
        hookRef("app.mutator", "agent-turn-finished", mutator),
        hookRef("app.observer", "agent-turn-finished", observer),
      ]),
    );

    expect(failures).toEqual([]);

    const event = finishedEvent();
    dispatcher.dispatchFinished(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((globalThis as LifecycleHookGlobal).__agentLifecycleHookEvents).toEqual([
      {
        appId: "app.observer",
        event: expect.objectContaining({
          turn: expect.objectContaining({ agentName: "main" }),
          metrics: expect.objectContaining({ toolCallCount: 0 }),
        }),
      },
    ]);
    expect(event.turn.agentName).toBe("main");
    expect(event.metrics.toolCallCount).toBe(0);
  });

  it("reports hook artifacts that do not implement the declared event method", async () => {
    const dir = await createHookDir("invalid", "return { onAgentTurnStarted() {} };");
    const dispatcher = createAgentLifecycleDispatcher();

    const failures = await dispatcher.loadFromCatalog(
      catalogWithHooks([hookRef("app.invalid", "agent-turn-finished", dir)]),
    );

    expect(failures).toEqual([
      expect.objectContaining({
        appId: "app.invalid",
        hookName: "agent-turn-finished",
        error: expect.stringContaining("onAgentTurnFinished"),
      }),
    ]);
  });

  it("passes appContext.repositories to hooks for resolved app-owned artifacts", async () => {
    const dir = await createHookDir(
      "with-context",
      `
  globalThis.__agentLifecycleHookDeps ??= [];
  globalThis.__agentLifecycleHookDeps.push({
    appId: deps.appId,
    repositories: deps.appContext?.repositories,
  });
  return {
    onAgentTurnFinished() {},
  };
  `,
    );
    const app = resolvedApp("app.with-context");
    const repositories: RomeAppRuntimeServices["repositories"] = {
      settings: {
        get: async () => null,
        set: async () => undefined,
      },
    };
    const dispatcher = createAgentLifecycleDispatcher({
      appRuntimeServices: {
        catalog: catalogWithResolvedAppAndHooks(app, []),
        db: {} as RomeAppRuntimeServices["db"],
        actionEngine: {} as ActionEngine,
        repositories,
      },
    });

    const failures = await dispatcher.loadFromCatalog(
      catalogWithResolvedAppAndHooks(app, [hookRef(app.appId, "agent-turn-finished", dir)]),
    );

    expect(failures).toEqual([]);
    expect((globalThis as LifecycleHookGlobal).__agentLifecycleHookDeps).toEqual([
      { appId: app.appId, repositories },
    ]);
  });

  it("loads hooks without appContext when the owner is not resolved", async () => {
    const dir = await createHookDir(
      "missing-context",
      `
  globalThis.__agentLifecycleHookDeps ??= [];
  globalThis.__agentLifecycleHookDeps.push({
    appId: deps.appId,
    repositories: deps.appContext?.repositories,
  });
  return {
    onAgentTurnFinished() {},
  };
  `,
    );
    const dispatcher = createAgentLifecycleDispatcher({
      appRuntimeServices: {
        catalog: catalogWithHooks([]),
        db: {} as RomeAppRuntimeServices["db"],
        actionEngine: {} as ActionEngine,
        repositories: {
          settings: {
            get: async () => null,
            set: async () => undefined,
          },
        },
      },
    });

    const failures = await dispatcher.loadFromCatalog(
      catalogWithHooks([hookRef("app.missing", "agent-turn-finished", dir)]),
    );

    expect(failures).toEqual([]);
    expect((globalThis as LifecycleHookGlobal).__agentLifecycleHookDeps).toEqual([
      { appId: "app.missing", repositories: undefined },
    ]);
  });

  it("runs finished listeners under the same root context used for hook fan-out", async () => {
    const dir = await createHookDir(
      "capture-context",
      `
  return {
    onAgentTurnFinished() {
      globalThis.__agentLifecycleCaptureHookContext(deps.appId);
    },
  };
  `,
    );
    const dispatcher = createAgentLifecycleDispatcher();
    (globalThis as LifecycleHookGlobal).__agentLifecycleCaptureHookContext = (appId) => {
      (globalThis as LifecycleHookGlobal).__agentLifecycleHookContexts ??= [];
      (globalThis as LifecycleHookGlobal).__agentLifecycleHookContexts!.push({
        appId,
        context: getCurrentHookInvocationContext(),
      });
    };
    dispatcher.onFinished(() => {
      (globalThis as LifecycleHookGlobal).__agentLifecycleListenerContext =
        getCurrentHookInvocationContext();
    });
    const failures = await dispatcher.loadFromCatalog(
      catalogWithHooks([hookRef("app.context", "agent-turn-finished", dir)]),
    );

    expect(failures).toEqual([]);

    dispatcher.dispatchFinished(finishedEvent());
    await flushHookDispatch();

    const listenerContext = (globalThis as LifecycleHookGlobal).__agentLifecycleListenerContext;
    const hookContext = (globalThis as LifecycleHookGlobal).__agentLifecycleHookContexts?.[0]
      ?.context;
    expect(listenerContext).toMatchObject({ depth: 0, chain: [] });
    expect(hookContext).toMatchObject({
      rootInvocationId: listenerContext?.rootInvocationId,
      depth: 1,
      chain: [
        {
          hookType: "lifecycle",
          appId: "app.context",
          hookName: "agent-turn-finished",
        },
      ],
    });
  });

  it("skips recursive same-hook dispatch without suppressing sibling hooks", async () => {
    const recursive = await createHookDir(
      "recursive",
      `
  return {
    onAgentTurnFinished(event) {
      globalThis.__agentLifecycleHookEvents ??= [];
      globalThis.__agentLifecycleHookEvents.push({ appId: deps.appId, event });
      if (!event.turn.turnId.endsWith("-nested")) {
        const nested = structuredClone(event);
        nested.turn.turnId = \`\${event.turn.turnId}-nested\`;
        const result = globalThis.__agentLifecycleNestedDispatcher.dispatchFinished(nested);
        globalThis.__agentLifecycleHookDispatchResults ??= [];
        globalThis.__agentLifecycleHookDispatchResults.push(result);
      }
    },
  };
  `,
    );
    const observer = await createHookDir("observer");
    const dispatcher = createAgentLifecycleDispatcher();
    (globalThis as LifecycleHookGlobal).__agentLifecycleNestedDispatcher = dispatcher;
    const failures = await dispatcher.loadFromCatalog(
      catalogWithHooks([
        hookRef("app.recursive", "agent-turn-finished", recursive),
        hookRef("app.observer", "agent-turn-finished", observer),
      ]),
    );

    expect(failures).toEqual([]);

    const result = dispatcher.dispatchFinished(finishedEvent());
    await flushHookDispatch();

    expect(result).toMatchObject({ invoked: 2, skipped: 0 });
    expect((globalThis as LifecycleHookGlobal).__agentLifecycleHookDispatchResults).toEqual([
      expect.objectContaining({
        invoked: 1,
        skipped: 1,
        skips: [
          expect.objectContaining({
            reason: "max_same_hook_depth",
            sameHookCount: 2,
          }),
        ],
      }),
    ]);
    expect(
      (globalThis as LifecycleHookGlobal).__agentLifecycleHookEvents?.map((entry) => [
        entry.appId,
        entry.event.turn.turnId,
      ]),
    ).toEqual([
      ["app.recursive", "turn-1"],
      ["app.observer", "turn-1"],
      ["app.observer", "turn-1-nested"],
    ]);
  });

  it("enforces maxHookDepth independently for every nested sibling candidate", async () => {
    const recursive = await createHookDir(
      "max-depth",
      `
  return {
    onAgentTurnFinished(event) {
      if (!event.turn.turnId.endsWith("-nested")) {
        const nested = structuredClone(event);
        nested.turn.turnId = \`\${event.turn.turnId}-nested\`;
        const result = globalThis.__agentLifecycleNestedDispatcher.dispatchFinished(nested);
        globalThis.__agentLifecycleHookDispatchResults ??= [];
        globalThis.__agentLifecycleHookDispatchResults.push(result);
      }
    },
  };
  `,
    );
    const observer = await createHookDir("observer-depth");
    const dispatcher = createAgentLifecycleDispatcher({
      hookRecursion: { maxHookDepth: 1, maxSameHookDepth: 1 },
    });
    (globalThis as LifecycleHookGlobal).__agentLifecycleNestedDispatcher = dispatcher;
    const failures = await dispatcher.loadFromCatalog(
      catalogWithHooks([
        hookRef("app.recursive", "agent-turn-finished", recursive),
        hookRef("app.observer", "agent-turn-finished", observer),
      ]),
    );

    expect(failures).toEqual([]);

    const result = dispatcher.dispatchFinished(finishedEvent());
    await flushHookDispatch();

    expect(result).toMatchObject({ invoked: 2, skipped: 0 });
    expect((globalThis as LifecycleHookGlobal).__agentLifecycleHookDispatchResults).toEqual([
      expect.objectContaining({
        invoked: 0,
        skipped: 2,
        skips: [
          expect.objectContaining({ reason: "max_hook_depth" }),
          expect.objectContaining({ reason: "max_hook_depth" }),
        ],
      }),
    ]);
    expect(
      (globalThis as LifecycleHookGlobal).__agentLifecycleHookEvents?.map((entry) => [
        entry.appId,
        entry.event.turn.turnId,
      ]),
    ).toEqual([["app.observer", "turn-1"]]);
  });

  async function createHookDir(name: string, body?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `rome-lifecycle-${name}-`));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "index.js"),
      `
export function createHook(deps) {
  ${
    body ??
    `
  return {
    onAgentTurnFinished(event) {
      globalThis.__agentLifecycleHookEvents ??= [];
      globalThis.__agentLifecycleHookEvents.push({ appId: deps.appId, event });
    },
  };
  `
  }
}
`,
      "utf-8",
    );
    return dir;
  }
});

async function flushHookDispatch(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function hookRef(
  ownerId: string,
  publicName: ArtifactRef["publicName"],
  absolutePath: string,
): ArtifactRef {
  return {
    kind: "hook",
    publicName,
    aliases: [],
    ownerType: "app",
    ownerId,
    absolutePath,
  };
}

function catalogWithHooks(hooks: ArtifactRef[]): AppCatalog {
  return {
    get() {
      return null;
    },
    listArtifacts(kind: string) {
      return kind === "hook" ? hooks : [];
    },
  } as unknown as AppCatalog;
}

function catalogWithResolvedAppAndHooks(app: ResolvedApp, hooks: ArtifactRef[]): AppCatalog {
  return {
    get(appId: string) {
      return appId === app.appId ? app : null;
    },
    listArtifacts(kind: string) {
      return kind === "hook" ? hooks : [];
    },
  } as unknown as AppCatalog;
}

function resolvedApp(appId: string): ResolvedApp {
  return {
    appId,
    state: "installed",
    enabled: true,
    firstParty: false,
    source: { mode: "bundle", path: "/tmp/app" },
    installedHash: "0".repeat(64),
    installedVersion: "1.0.0",
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    manifest: {
      id: appId,
      version: "1.0.0",
      description: "Lifecycle test app",
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
    api: null,
    db: null,
  };
}

function finishedEvent(): AgentTurnFinishedEvent {
  return {
    type: "agent-turn-finished",
    version: 1,
    turn: {
      sessionId: "session-1",
      turnId: "turn-1",
      agentName: "main",
    },
    status: "completed",
    timing: {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
    },
    output: {
      text: "done",
      state: "final",
      terminalKind: "result",
    },
    metrics: {
      toolCallCount: 0,
      skillWritten: false,
    },
  };
}
