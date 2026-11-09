import { describe, expect, it } from "@rstest/core";
import type { Action } from "../apps/actions/types.js";
import type { ArtifactMetadata } from "../apps/types.js";
import type { AppView, ResolvedApp } from "../apps/state.js";
import type { Logger } from "../logger.js";
import { FavorRequirementSync, favorActionRequirementsForApp } from "./catalog-sync.js";
import type { FavorService } from "./types.js";

function action(
  name: string,
  overrides: Partial<Action> & { ownerId?: string } = {},
): { action: Action; metadata: ArtifactMetadata } {
  const { ownerId = "report-shop", ...actionOverrides } = overrides;
  const action: Action = {
    config: {
      name,
      type: "custom",
      description: name,
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "write",
    },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ status: "ok" }),
    ...actionOverrides,
  };
  return {
    action,
    metadata: {
      kind: "action",
      ownerType: "app",
      ownerId,
      publicName: name,
      aliases: [],
      sourcePath: `/apps/${ownerId}/${name}`,
    },
  };
}

function catalog(entries: Array<{ action: Action; metadata: ArtifactMetadata }>) {
  return {
    list: () => entries.map((entry) => entry.action.config.name),
    get: (name: string) => entries.find((entry) => entry.action.config.name === name)?.action,
    getMetadata: (name: string) =>
      entries.find((entry) => entry.action.config.name === name)?.metadata,
  };
}

describe("favorActionRequirementsForApp", () => {
  it("derives favor definitions from app-owned action config", () => {
    const app = { appId: "report-shop" } as ResolvedApp;
    const paid = action("summarize_report", {
      config: {
        name: "summarize_report",
        type: "custom",
        description: "Summarize a report",
        complexity: "moderate",
        speed: "slow",
        reliability: "medium",
        sideEffects: "write",
        favorRequirement: {
          amount: 25,
          title: "Summarize a report",
          summary: "Create a concise summary.",
          displayFields: [{ label: "Report", from: "$.reportUrl" }],
        },
      },
      inputSchema: {
        type: "object",
        properties: { reportUrl: { type: "string", format: "uri" } },
        required: ["reportUrl"],
      },
    });
    const free = action("free_preview");
    const otherApp = action("other_paid", {
      ownerId: "other-app",
      config: {
        name: "other_paid",
        type: "custom",
        description: "Other",
        complexity: "simple",
        speed: "fast",
        reliability: "high",
        sideEffects: "write",
        favorRequirement: { amount: 10, title: "Other" },
      },
    });

    expect(favorActionRequirementsForApp(app, catalog([paid, free, otherApp]))).toEqual([
      {
        actionName: "summarize_report",
        amount: 25,
        title: "Summarize a report",
        summary: "Create a concise summary.",
        argsSchema: paid.action.inputSchema,
        displayFields: [{ label: "Report", from: "$.reportUrl" }],
      },
    ]);
  });

  it("requires an input schema for favor-required actions", () => {
    const app = { appId: "report-shop" } as ResolvedApp;
    const paid = action("summarize_report", {
      config: {
        name: "summarize_report",
        type: "custom",
        description: "Summarize a report",
        complexity: "moderate",
        speed: "slow",
        reliability: "medium",
        sideEffects: "write",
        favorRequirement: { amount: 25, title: "Summarize a report" },
      },
      inputSchema: undefined,
    });

    expect(() => favorActionRequirementsForApp(app, catalog([paid]))).toThrow(
      'Favor-required action "summarize_report" must expose inputSchema',
    );
  });
});

type SyncInput = Parameters<FavorService["syncActionRequirements"]>[0];

function resolvedApp(appId: string, version = "1.0.0"): ResolvedApp {
  return { appId, state: "installed", manifest: { id: appId, version } } as unknown as ResolvedApp;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(opts: { apps: ResolvedApp[]; concurrency?: number }) {
  const apps = new Map<string, AppView | ResolvedApp>(opts.apps.map((app) => [app.appId, app]));
  const calls: SyncInput[] = [];
  const gates: Array<{ input: SyncInput; release: () => void; fail: (err: Error) => void }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const favorService = {
    syncActionRequirements: async (input: SyncInput) => {
      calls.push(input);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise<void>((resolve, reject) => {
          gates.push({ input, release: resolve, fail: reject });
        });
      } finally {
        inFlight--;
      }
      return { synced: input.definitions.length };
    },
  } as unknown as FavorService;
  const sync = new FavorRequirementSync({
    favorService,
    appCatalog: {
      get: (appId: string) => apps.get(appId) ?? null,
      listResolved: () => [...apps.values()] as ResolvedApp[],
    },
    actionCatalog: catalog([]),
    log: { debug: () => {} } as unknown as Logger,
    concurrency: opts.concurrency,
  });
  const releaseAll = async () => {
    while (gates.length > 0) {
      gates.shift()?.release();
      await flush();
    }
  };
  return { apps, calls, gates, sync, releaseAll, maxInFlight: () => maxInFlight };
}

describe("FavorRequirementSync", () => {
  it("syncs apps in parallel up to the concurrency limit", async () => {
    const h = harness({
      apps: ["a", "b", "c", "d", "e", "f"].map((id) => resolvedApp(id)),
      concurrency: 4,
    });

    const all = h.sync.syncAll();
    await flush();
    expect(h.calls.map((call) => call.appId)).toEqual(["a", "b", "c", "d"]);

    await h.releaseAll();
    await all;
    expect(h.calls.map((call) => call.appId).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(h.maxInFlight()).toBe(4);
  });

  it("sends an app's state as of when its sync starts, after the sync in flight", async () => {
    const h = harness({ apps: [resolvedApp("shop", "1.0.0")] });

    const first = h.sync.sync("shop");
    await flush();
    h.apps.set("shop", resolvedApp("shop", "2.0.0"));
    const second = h.sync.sync("shop");
    const third = h.sync.sync("shop");
    await flush();
    // The second sync waits for the first, and the third shares the second.
    expect(h.calls).toHaveLength(1);
    expect(third).toBe(second);

    await h.releaseAll();
    await Promise.all([first, second, third]);
    expect(h.calls.map((call) => call.requesterAppIdentity.version)).toEqual(["1.0.0", "2.0.0"]);
  });

  it("sends no definitions for an app that left the catalog", async () => {
    const h = harness({ apps: [resolvedApp("shop")] });
    h.apps.delete("shop");

    const done = h.sync.sync("shop");
    await flush();
    await h.releaseAll();
    await done;
    expect(h.calls).toEqual([
      { appId: "shop", requesterAppIdentity: { appId: "shop", state: "removed" }, definitions: [] },
    ]);
  });

  it("drops a failed sync without rejecting and keeps syncing", async () => {
    const h = harness({ apps: [resolvedApp("a"), resolvedApp("b")], concurrency: 1 });

    const all = h.sync.syncAll();
    await flush();
    h.gates.shift()?.fail(new Error("Rome Cloud unavailable"));
    await flush();
    await h.releaseAll();
    await expect(all).resolves.toBeUndefined();
    expect(h.calls.map((call) => call.appId)).toEqual(["a", "b"]);
  });
});
