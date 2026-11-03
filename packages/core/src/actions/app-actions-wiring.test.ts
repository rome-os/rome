import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppRuntimeRepositories } from "@rome-os/app-runtime";
import { describe, expect, it, rs } from "@rstest/core";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { ArtifactRef, ResolvedApp } from "../apps/state.js";
import type { DrizzleDb } from "../db/index.js";
import { createAppActionsSubscriber } from "./app-actions-wiring.js";
import type { ActionEngine } from "./engine.js";
import { ActionLoader } from "./loader.js";
import { ActionRegistryImpl } from "./registry.js";

function resolvedApp(appId: string, actions: ArtifactRef[]): ResolvedApp {
  return {
    appId,
    state: "installed",
    enabled: true,
    firstParty: false,
    source: { mode: "bundle", path: "/tmp/unused" },
    installedHash: "0".repeat(64),
    installedVersion: "0.0.1",
    lastError: null,
    updatedAt: new Date(0).toISOString(),
    manifest: {
      id: appId,
      version: "0.0.1",
      description: "Test app",
      agents: [],
      actions: [],
      skills: [],
      hooks: [],
    },
    rootPath: "/tmp/unused",
    resolveRoot: "/tmp/unused",
    displayName: "Test App",
    iconAbsolutePath: undefined,
    artifacts: { agent: [], action: actions, skill: [], hook: [] },
    web: null,
    api: null,
    db: null,
  };
}

describe("createAppActionsSubscriber", () => {
  it("warns with the app actions that failed to initialize on a catalog event", async () => {
    const root = await mkdtemp(join(tmpdir(), "rome-app-actions-"));
    try {
      // A valid action.yaml with no entry module: the loader accepts the
      // config, and instantiation fails.
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
      const app = resolvedApp("feeds", [
        {
          kind: "action",
          publicName: "sync",
          aliases: [],
          ownerType: "app",
          ownerId: "feeds",
          absolutePath: actionDir,
          formatVersion: 2,
        },
      ]);
      const catalog = {
        get: (appId: string) => (appId === app.appId ? app : null),
        listArtifacts: (kind: "action") => app.artifacts[kind],
      } as unknown as AppCatalog;
      const identity = { legacyBindings: createEmptyLegacyArtifactBindings() };
      const actionLoader = new ActionLoader(identity);
      await actionLoader.loadFromCatalog(catalog);
      const actionRegistry = new ActionRegistryImpl(identity);
      const log = { warn: rs.fn() };
      const subscriber = createAppActionsSubscriber(
        actionLoader,
        actionRegistry,
        catalog,
        {},
        {
          db: {} as DrizzleDb,
          actionEngine: {} as ActionEngine,
          repositories: {} as AppRuntimeRepositories,
        },
        log,
      );

      await subscriber({ appId: "feeds", change: "changed", current: app });

      expect(actionRegistry.has("feeds:sync")).toBe(false);
      expect(log.warn).toHaveBeenCalledWith("some app actions failed to initialize", {
        appId: "feeds",
        failed: [
          {
            name: "feeds:sync",
            ownerId: "feeds",
            error: expect.stringMatching(/No entry module found/),
          },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
