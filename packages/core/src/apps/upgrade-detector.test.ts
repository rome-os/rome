import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { AppCatalog } from "./catalog.js";
import type { RomeCloudListingClient } from "./rome-cloud-listing-client.js";
import type { AppView, ResolvedApp } from "./state.js";
import type { RomeAppManifest } from "./types.js";
import { findUpgradeCandidates } from "./upgrade-detector.js";

function makeManifest(
  overrides: Partial<RomeAppManifest> & Pick<RomeAppManifest, "id" | "version">,
): RomeAppManifest {
  return {
    description: "fixture",
    agents: [],
    actions: [],
    skills: [],
    hooks: [],
    ...overrides,
  };
}

function makeResolvedApp(
  overrides: Partial<ResolvedApp> & Pick<ResolvedApp, "appId" | "source" | "manifest">,
): ResolvedApp {
  return {
    enabled: true,
    firstParty: false,
    state: "installed",
    installedHash: "deadbeef",
    installedVersion: overrides.manifest.version,
    lastError: null,
    updatedAt: new Date(0).toISOString(),
    rootPath: "/installed/active",
    resolveRoot: "/installed/active",
    displayName: overrides.manifest.id,
    iconAbsolutePath: undefined,
    artifacts: { agent: [], action: [], skill: [], hook: [] },
    web: null,
    api: null,
    db: null,
    ...overrides,
  };
}

function makeCatalog(views: readonly (AppView | ResolvedApp)[]): AppCatalog {
  return { list: () => Object.freeze([...views]) } as unknown as AppCatalog;
}

function makeListings(map: Record<string, string | null>): RomeCloudListingClient {
  return {
    getHighestVersion: async (listingId: string) => map[listingId] ?? null,
    getContentHash: async () => null,
  };
}

describe("findUpgradeCandidates", () => {
  describe("appstore probe", () => {
    it("compares installed artifact manifest version (not lockfile source.version) against Rome Cloud", async () => {
      // Lockfile spec descriptor says 1.0.0, but the installed artifact's
      // manifest is 1.1.0 (drift). Rome Cloud also reports 1.1.0. The detector
      // should treat 1.1.0 as installed and report no upgrade — using the
      // old `view.source.version` would have falsely reported 1.0.0 → 1.1.0.
      const view = makeResolvedApp({
        appId: "drift-app",
        source: {
          mode: "appstore",
          listingId: "drift-listing",
          version: "1.0.0",
          contentHash: "a".repeat(64),
        },
        manifest: makeManifest({ id: "drift-app", version: "1.1.0" }),
      });
      const catalog = makeCatalog([view]);
      const listings = makeListings({ "drift-listing": "1.1.0" });

      const summary = await findUpgradeCandidates(catalog, { romeCloudListings: listings });

      expect(summary.upgradable).toEqual([]);
    });

    it("reports a real upgrade when Rome Cloud's highest version exceeds the installed manifest version", async () => {
      const view = makeResolvedApp({
        appId: "ready-to-upgrade",
        source: {
          mode: "appstore",
          listingId: "ready-listing",
          version: "1.1.0",
          contentHash: "b".repeat(64),
        },
        manifest: makeManifest({ id: "ready-to-upgrade", version: "1.1.0" }),
      });
      const catalog = makeCatalog([view]);
      const listings = makeListings({ "ready-listing": "1.2.0" });

      const summary = await findUpgradeCandidates(catalog, { romeCloudListings: listings });

      expect(summary.upgradable).toEqual([
        {
          appId: "ready-to-upgrade",
          currentVersion: "1.1.0",
          availableVersion: "1.2.0",
          targetSource: {
            mode: "appstore",
            listingId: "ready-listing",
            version: "1.2.0",
          },
        },
      ]);
    });

    it("skips appstore apps when no listings client is provided", async () => {
      const view = makeResolvedApp({
        appId: "no-client",
        source: {
          mode: "appstore",
          listingId: "no-client-listing",
          version: "1.0.0",
          contentHash: "c".repeat(64),
        },
        manifest: makeManifest({ id: "no-client", version: "1.0.0" }),
      });

      const summary = await findUpgradeCandidates(makeCatalog([view]));

      expect(summary.upgradable).toEqual([]);
    });

    it("silently skips when Rome Cloud throws", async () => {
      const view = makeResolvedApp({
        appId: "flaky",
        source: {
          mode: "appstore",
          listingId: "flaky-listing",
          version: "1.0.0",
          contentHash: "d".repeat(64),
        },
        manifest: makeManifest({ id: "flaky", version: "1.0.0" }),
      });
      const listings: RomeCloudListingClient = {
        getHighestVersion: async () => {
          throw new Error("network down");
        },
        getContentHash: async () => null,
      };

      const summary = await findUpgradeCandidates(makeCatalog([view]), {
        romeCloudListings: listings,
      });

      expect(summary.upgradable).toEqual([]);
    });
  });

  describe("workspace probe", () => {
    let workRoot: string;
    beforeEach(async () => {
      workRoot = await mkdtemp(join(tmpdir(), "upgrade-detector-"));
    });
    afterEach(async () => {
      await rm(workRoot, { recursive: true, force: true });
    });

    async function writeAppYaml(dir: string, version: string): Promise<string> {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "app.yaml"),
        `formatVersion: 1\nid: ws-app\nversion: ${version}\ndescription: fixture\nagents: []\nactions: []\nskills: []\nhooks: []\n`,
        "utf-8",
      );
      return dir;
    }

    it("reports a candidate when the source-side packed artifact's app.yaml is newer than the installed manifest", async () => {
      const sourcePath = await writeAppYaml(join(workRoot, "packed"), "1.1.0");
      const view = makeResolvedApp({
        appId: "ws-app",
        source: { mode: "bundle", path: sourcePath },
        manifest: makeManifest({ id: "ws-app", version: "1.0.0" }),
      });

      const summary = await findUpgradeCandidates(makeCatalog([view]));

      expect(summary.upgradable).toEqual([
        {
          appId: "ws-app",
          currentVersion: "1.0.0",
          availableVersion: "1.1.0",
          targetSource: { mode: "bundle", path: sourcePath },
        },
      ]);
    });

    it("returns no candidate when the source-side packed artifact matches the installed manifest", async () => {
      const sourcePath = await writeAppYaml(join(workRoot, "packed"), "1.0.0");
      const view = makeResolvedApp({
        appId: "ws-app",
        source: { mode: "bundle", path: sourcePath },
        manifest: makeManifest({ id: "ws-app", version: "1.0.0" }),
      });

      const summary = await findUpgradeCandidates(makeCatalog([view]));

      expect(summary.upgradable).toEqual([]);
    });

    it("never advertises a first-party app, even when its artifact is newer (boot owns those upgrades)", async () => {
      const sourcePath = await writeAppYaml(join(workRoot, "packed"), "2.0.0");
      const view = makeResolvedApp({
        appId: "ws-app",
        firstParty: true,
        source: { mode: "bundle", path: sourcePath },
        manifest: makeManifest({ id: "ws-app", version: "1.0.0" }),
      });

      const summary = await findUpgradeCandidates(makeCatalog([view]));

      expect(summary.upgradable).toEqual([]);
    });
  });

  it("skips unresolved views (no manifest)", async () => {
    const unresolved: AppView = {
      appId: "pending",
      state: "installing",
      enabled: true,
      firstParty: false,
      installedHash: null,
      installedVersion: null,
      lastError: null,
      updatedAt: new Date(0).toISOString(),
      source: {
        mode: "appstore",
        listingId: "pending-listing",
        version: "1.0.0",
        contentHash: "e".repeat(64),
      },
    };
    const listings = makeListings({ "pending-listing": "9.9.9" });

    const summary = await findUpgradeCandidates(makeCatalog([unresolved]), {
      romeCloudListings: listings,
    });

    expect(summary.upgradable).toEqual([]);
  });
});
