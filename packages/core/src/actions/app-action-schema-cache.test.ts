import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppRuntimeRepositories } from "@rome-os/app-runtime";
import { afterEach, describe, expect, it } from "@rstest/core";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { ResolvedApp } from "../apps/state.js";
import type { DrizzleDb } from "../db/index.js";
import { AppActionSchemaCache } from "./app-action-schema-cache.js";
import { registerAppActions } from "./app-actions-wiring.js";
import type { ActionEngine } from "./engine.js";
import { ActionLoader } from "./loader.js";
import { ActionRegistryImpl } from "./registry.js";

type ImportCountGlobal = typeof globalThis & { __schemaCacheInstantiations?: number };
const counter = globalThis as ImportCountGlobal;

const INPUT_SCHEMA = {
  type: "object",
  properties: { feed: { type: "string" } },
  required: ["feed"],
  additionalProperties: false,
};

const roots: string[] = [];

afterEach(async () => {
  delete counter.__schemaCacheInstantiations;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function appWithAction(installedHash: string): Promise<{ root: string; app: ResolvedApp }> {
  const root = await mkdtemp(join(tmpdir(), "rome-schema-cache-"));
  roots.push(root);
  const actionDir = join(root, "sync");
  await mkdir(actionDir, { recursive: true });
  await writeFile(
    join(actionDir, "action.yaml"),
    [
      "name: sync",
      "type: custom",
      "description: Syncs the feed.",
      "complexity: simple",
      "speed: fast",
      "reliability: high",
      "sideEffects: write",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(actionDir, "index.js"),
    `
export function createAction(config) {
  globalThis.__schemaCacheInstantiations = (globalThis.__schemaCacheInstantiations ?? 0) + 1;
  return {
    config,
    inputSchema: ${JSON.stringify(INPUT_SCHEMA)},
    execute: async (args) => ({ status: "ok", data: { feed: args.feed } }),
  };
}
`,
  );
  const app: ResolvedApp = {
    appId: "feeds",
    state: "installed",
    enabled: true,
    firstParty: false,
    source: { mode: "bundle", path: root },
    installedHash,
    installedVersion: "0.0.1",
    lastError: null,
    updatedAt: new Date(0).toISOString(),
    manifest: {
      id: "feeds",
      version: "0.0.1",
      description: "Test app",
      agents: [],
      actions: [],
      skills: [],
      hooks: [],
    },
    rootPath: root,
    resolveRoot: root,
    displayName: "Feeds",
    iconAbsolutePath: undefined,
    artifacts: {
      agent: [],
      action: [
        {
          kind: "action",
          publicName: "sync",
          aliases: [],
          ownerType: "app",
          ownerId: "feeds",
          absolutePath: actionDir,
          formatVersion: 2,
        },
      ],
      skill: [],
      hook: [],
    },
    web: null,
    api: null,
    db: null,
  };
  return { root, app };
}

async function register(app: ResolvedApp, schemaCache: AppActionSchemaCache | null) {
  const catalog = {
    get: (appId: string) => (appId === app.appId ? app : null),
    listArtifacts: (kind: "action") => app.artifacts[kind],
  } as unknown as AppCatalog;
  const identity = { legacyBindings: createEmptyLegacyArtifactBindings() };
  const actionLoader = new ActionLoader(identity);
  await actionLoader.loadFromCatalog(catalog);
  const actionRegistry = new ActionRegistryImpl(identity);
  const result = await registerAppActions(
    actionLoader,
    actionRegistry,
    catalog,
    {},
    {
      db: {} as DrizzleDb,
      actionEngine: {} as ActionEngine,
      repositories: {} as AppRuntimeRepositories,
    },
    { schemaCache },
  );
  return { result, actionRegistry };
}

describe("AppActionSchemaCache", () => {
  it("registers an unchanged bundle's action without importing it on the next boot", async () => {
    const { root, app } = await appWithAction("a".repeat(64));
    const cachePath = join(root, "action-schemas.json");

    const first = await register(app, await AppActionSchemaCache.load(cachePath, "build-1"));
    expect(first.result.loaded).toEqual(["feeds:sync"]);
    expect(counter.__schemaCacheInstantiations).toBe(1);

    const second = await register(app, await AppActionSchemaCache.load(cachePath, "build-1"));
    expect(second.result.loaded).toEqual(["feeds:sync"]);
    expect(counter.__schemaCacheInstantiations).toBe(1);
    expect(second.actionRegistry.get("feeds:sync")?.inputSchema).toEqual(INPUT_SCHEMA);

    const result = await second.actionRegistry.get("feeds:sync")?.execute({ feed: "news" });
    expect(result).toEqual({ status: "ok", data: { feed: "news" } });
    expect(counter.__schemaCacheInstantiations).toBe(2);
  });

  it("imports again when the bundle hash changes", async () => {
    const { root, app } = await appWithAction("a".repeat(64));
    const cachePath = join(root, "action-schemas.json");
    await register(app, await AppActionSchemaCache.load(cachePath, "build-1"));

    const upgraded = { ...app, installedHash: "b".repeat(64) };
    const cache = await AppActionSchemaCache.load(cachePath, "build-1");
    expect(
      cache?.get(AppActionSchemaCache.key("feeds", upgraded.installedHash, "feeds:sync")!),
    ).toBeUndefined();
    await register(upgraded, cache);

    const saved = JSON.parse(await readFile(cachePath, "utf-8")) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(saved.entries)).toEqual([`feeds\0${"b".repeat(64)}\0feeds:sync`]);
  });

  it("starts empty for another build and is off without a build identity", async () => {
    const { root, app } = await appWithAction("a".repeat(64));
    const cachePath = join(root, "action-schemas.json");
    await register(app, await AppActionSchemaCache.load(cachePath, "build-1"));

    const otherBuild = await AppActionSchemaCache.load(cachePath, "build-2");
    expect(
      otherBuild?.get(AppActionSchemaCache.key("feeds", app.installedHash, "feeds:sync")!),
    ).toBeUndefined();
    expect(await AppActionSchemaCache.load(cachePath, null)).toBeNull();
  });
});
