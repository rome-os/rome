import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogEvent, ResolvedApp } from "../state.js";
import { createOgImageStore } from "./store.js";
import { cardDescription, createAppOgImageSubscriber } from "./subscriber.js";

function resolvedApp(overrides: Partial<ResolvedApp> = {}): ResolvedApp {
  return {
    appId: "reddit",
    state: "installed",
    enabled: true,
    updatedAt: "2026-09-01T00:00:00.000Z",
    displayName: "Reddit Radar",
    manifest: { id: "reddit", description: "Watches subreddits" },
    web: { displayName: "Reddit Radar" },
    ...overrides,
  } as unknown as ResolvedApp;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("cardDescription", () => {
  it("returns the tagline when present", () => {
    expect(cardDescription({ tagline: "Never miss a good thread" })).toBe(
      "Never miss a good thread",
    );
  });

  it("returns null when there is no tagline", () => {
    expect(cardDescription({})).toBeNull();
  });
});

describe("createAppOgImageSubscriber", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rome-og-sub-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("generates an image for an installed web app and passes the full-route link", async () => {
    const store = createOgImageStore(root);
    const calls: Array<string | null> = [];
    const handler = createAppOgImageSubscriber({
      store,
      host: "jessie.romeos.cc",
      generate: async (_app, link) => {
        calls.push(link);
        return Buffer.from("png");
      },
    });
    await handler({ appId: "reddit", change: "added", current: resolvedApp() });
    await tick();
    expect(calls).toEqual(["jessie.romeos.cc/full/apps/reddit"]);
    expect(await store.read("reddit")).not.toBeNull();
  });

  it("skips when the image is newer than the app's updatedAt, and regenerates when older", async () => {
    const store = createOgImageStore(root);
    let calls = 0;
    const handler = createAppOgImageSubscriber({
      store,
      host: null,
      generate: async () => {
        calls += 1;
        return Buffer.from("png");
      },
    });
    await store.write("reddit", Buffer.from("old"));
    await handler({ appId: "reddit", change: "changed", current: resolvedApp() });
    await tick();
    expect(calls).toBe(0);

    const stale = new Date("2026-08-01T00:00:00.000Z");
    utimesSync(store.path("reddit"), stale, stale);
    await handler({ appId: "reddit", change: "changed", current: resolvedApp() });
    await tick();
    expect(calls).toBe(1);
  });

  it("ignores disabled apps, apps without a frontend, bare views, and removes on uninstall", async () => {
    const store = createOgImageStore(root);
    let calls = 0;
    const handler = createAppOgImageSubscriber({
      store,
      host: null,
      generate: async () => {
        calls += 1;
        return Buffer.from("png");
      },
    });
    await handler({ appId: "reddit", change: "added", current: resolvedApp({ enabled: false }) });
    await handler({ appId: "reddit", change: "added", current: resolvedApp({ web: null }) });
    await handler({
      appId: "reddit",
      change: "added",
      current: { appId: "reddit", state: "installed", enabled: true } as CatalogEvent["current"],
    });
    await tick();
    expect(calls).toBe(0);

    await store.write("reddit", Buffer.from("png"));
    await handler({ appId: "reddit", change: "removed", current: null });
    expect(await store.stat("reddit")).toBeNull();
  });

  it("returns immediately and swallows generator failures", async () => {
    const store = createOgImageStore(root);
    const handler = createAppOgImageSubscriber({
      store,
      host: null,
      generate: () => new Promise((_r, reject) => setTimeout(() => reject(new Error("boom")), 10)),
    });
    const started = Date.now();
    await handler({ appId: "reddit", change: "added", current: resolvedApp() });
    expect(Date.now() - started).toBeLessThan(10);
    await tick();
    expect(await store.stat("reddit")).toBeNull();
  });

  it("discards a render that finishes after the app was removed", async () => {
    const store = createOgImageStore(root);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const handler = createAppOgImageSubscriber({
      store,
      host: null,
      generate: async () => {
        await gate;
        return Buffer.from("stale");
      },
    });
    await handler({ appId: "reddit", change: "added", current: resolvedApp() });
    await handler({ appId: "reddit", change: "removed", current: null });
    release();
    await tick();
    expect(await store.stat("reddit")).toBeNull();
  });

  it("keeps the newest render when an older one finishes last", async () => {
    const store = createOgImageStore(root);
    // Gates keyed by the app's updatedAt: the two renders reach `generate`
    // after independent fs stats, so arrival order is not event order.
    const gates = new Map<string, () => void>();
    const handler = createAppOgImageSubscriber({
      store,
      host: null,
      generate: async (app) => {
        await new Promise<void>((r) => gates.set(app.updatedAt, r));
        return Buffer.from(app.updatedAt);
      },
    });
    const older = "2026-09-01T00:00:00.000Z";
    const newer = "2026-09-02T00:00:00.000Z";
    await handler({ appId: "reddit", change: "added", current: resolvedApp({ updatedAt: older }) });
    await handler({
      appId: "reddit",
      change: "changed",
      current: resolvedApp({ updatedAt: newer }),
    });
    while (gates.size < 2) await tick();
    gates.get(newer)?.(); // newest finishes first
    await tick();
    gates.get(older)?.(); // stale one finishes last
    await tick();
    expect((await store.read("reddit"))?.toString()).toBe(newer);
  });

  it("does not recreate the card when removal arrives while a write is queued", async () => {
    const store = createOgImageStore(root);
    let releaseGenerate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGenerate = r;
    });
    const handler = createAppOgImageSubscriber({
      store,
      host: null,
      generate: async () => {
        await gate;
        return Buffer.from("late");
      },
    });
    await handler({ appId: "reddit", change: "added", current: resolvedApp() });
    releaseGenerate();
    // Let the render reach the queue, then remove before its write can commit.
    await Promise.resolve();
    await handler({ appId: "reddit", change: "removed", current: null });
    await tick();
    expect(await store.stat("reddit")).toBeNull();
  });
});
