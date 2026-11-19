import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import type { ReleaseNotesFile } from "@rome/api-types/release-notes";
import { compareVersions, ReleaseNotes } from "./release-notes.js";

const BASE = "https://notes.test/download";

function notes(
  version: string,
  previousVersion: string | null,
  extra: Partial<ReleaseNotesFile> = {},
) {
  return {
    schema: 1,
    version,
    previousVersion,
    date: "2026-11-18T00:00:00Z",
    url: `https://github.com/rome-os/rome/releases/tag/v${version}`,
    breaking: [],
    new: [],
    fixes: [],
    internal: 0,
    ...extra,
  } satisfies ReleaseNotesFile;
}

/** A fake GitHub: `assets` maps a version to its file, a status, or a thrown error. */
function github(assets: Record<string, unknown>) {
  const requested: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const version = /\/v([^/]+)\/release-notes\.json$/.exec(url)?.[1] ?? "";
    const asset = assets[version];
    if (asset === undefined) return new Response("Not Found", { status: 404 });
    if (asset instanceof Error) throw asset;
    if (typeof asset === "number") return new Response("", { status: asset });
    return Response.json(asset);
  }) as typeof globalThis.fetch;
  return { fetch, requested };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function cacheDir() {
  const dir = mkdtempSync(join(tmpdir(), "rome-release-notes-"));
  dirs.push(dir);
  return dir;
}

describe("compareVersions", () => {
  it("orders by number, with a prerelease below its release", () => {
    expect(compareVersions("1.1.10", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("1.2.0-rc.1", "1.2.0")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
  });
});

describe("ReleaseNotes.range", () => {
  it("walks back to the running version and merges, breaking first and one entry per PR", async () => {
    const { fetch } = github({
      "1.1.210": notes("1.1.210", "1.1.209", {
        new: [{ scope: "web", text: "newer wording", pr: 5 }],
        fixes: [{ scope: "web", text: "a fix", pr: 6 }],
        internal: 2,
      }),
      "1.1.209": notes("1.1.209", "1.1.207", {
        breaking: [{ scope: "core", text: "drop a route", pr: 4 }],
        new: [
          { scope: "web", text: "older wording", pr: 5 },
          { scope: null, text: "a direct push", pr: null },
        ],
        internal: 1,
      }),
      "1.1.207": notes("1.1.207", "1.1.206", { fixes: [{ scope: "ios", text: "old", pr: 1 }] }),
    });
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch });

    const range = await store.range("1.1.208", "1.1.210");

    expect(range.status).toBe("complete");
    expect(range.releases.map((r) => r.version)).toEqual(["1.1.210", "1.1.209"]);
    expect(range.coveredFrom).toBe("1.1.207");
    expect(range.breaking).toEqual([
      { scope: "core", text: "drop a route", pr: 4, version: "1.1.209" },
    ]);
    expect(range.new).toEqual([
      { scope: "web", text: "newer wording", pr: 5, version: "1.1.210" },
      { scope: null, text: "a direct push", pr: null, version: "1.1.209" },
    ]);
    expect(range.fixes).toEqual([{ scope: "web", text: "a fix", pr: 6, version: "1.1.210" }]);
    expect(range.internal).toBe(3);
    expect(range.compareUrl).toBe("https://github.com/rome-os/rome/compare/v1.1.208...v1.1.210");
  });

  it("keeps a pull request's entry from the newest release that lists it, in any section", async () => {
    const { fetch } = github({
      "1.0.3": notes("1.0.3", "1.0.2", { fixes: [{ scope: "web", text: "newest", pr: 7 }] }),
      "1.0.2": notes("1.0.2", "1.0.1", {
        new: [
          { scope: "web", text: "older", pr: 7 },
          { scope: "web", text: "both", pr: 8 },
        ],
        breaking: [{ scope: "web", text: "both, breaking", pr: 8 }],
      }),
    });
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch });

    const range = await store.range("1.0.1", "1.0.3");

    expect(range.fixes).toEqual([{ scope: "web", text: "newest", pr: 7, version: "1.0.3" }]);
    expect(range.new).toEqual([]);
    expect(range.breaking).toEqual([
      { scope: "web", text: "both, breaking", pr: 8, version: "1.0.2" },
    ]);
  });

  it("without a start reads the target's release alone", async () => {
    const { fetch, requested } = github({ "1.1.210": notes("1.1.210", "1.1.209") });
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch });

    const range = await store.range(null, "1.1.210");

    expect(range.status).toBe("complete");
    expect(requested).toHaveLength(1);
    expect(range.compareUrl).toBeNull();
  });

  it("is partial when an older release has no notes, and covers what it found", async () => {
    const { fetch } = github({
      "1.1.210": notes("1.1.210", "1.1.209", { new: [{ scope: "web", text: "a", pr: 9 }] }),
    });
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch });

    const range = await store.range("1.1.200", "1.1.210");

    expect(range.status).toBe("partial");
    expect(range.coveredFrom).toBe("1.1.209");
    expect(range.new).toHaveLength(1);
  });

  it("is partial when a release in the range does not name its predecessor", async () => {
    const atTarget = new ReleaseNotes({
      baseUrl: BASE,
      cacheDir: null,
      fetch: github({ "1.0.3": notes("1.0.3", null) }).fetch,
    });
    const target = await atTarget.range("1.0.1", "1.0.3");
    expect(target.status).toBe("partial");
    expect(target.coveredFrom).toBeNull();
    expect(target.releases.map((r) => r.version)).toEqual(["1.0.3"]);

    const older = new ReleaseNotes({
      baseUrl: BASE,
      cacheDir: null,
      fetch: github({ "1.0.3": notes("1.0.3", "1.0.2"), "1.0.2": notes("1.0.2", null) }).fetch,
    });
    const range = await older.range("1.0.0", "1.0.3");
    expect(range.status).toBe("partial");
    expect(range.coveredFrom).toBeNull();
    expect(range.releases.map((r) => r.version)).toEqual(["1.0.3", "1.0.2"]);

    // Without a start there is no range to cover, only the target's release.
    expect((await atTarget.range(null, "1.0.3")).status).toBe("complete");
  });

  it("is partial past the cap", async () => {
    const assets: Record<string, unknown> = {};
    for (let patch = 1; patch <= 10; patch += 1) {
      assets[`1.0.${patch}`] = notes(`1.0.${patch}`, `1.0.${patch - 1}`);
    }
    const { fetch, requested } = github(assets);
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch, maxReleases: 3 });

    const range = await store.range("1.0.0", "1.0.10");

    expect(range.status).toBe("partial");
    expect(range.releases.map((r) => r.version)).toEqual(["1.0.10", "1.0.9", "1.0.8"]);
    expect(range.coveredFrom).toBe("1.0.7");
    expect(requested).toHaveLength(3);
  });

  it("is missing when the target has no notes, and failed when they cannot be read", async () => {
    const missing = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch: github({}).fetch });
    const range = await missing.range("1.0.0", "1.0.1");
    expect(range.status).toBe("missing");
    expect(range.releases).toEqual([]);
    expect(range.releaseUrl).toBe("https://github.com/rome-os/rome/releases/tag/v1.0.1");

    const cases: unknown[] = [
      new TypeError("fetch failed"),
      500,
      { ...notes("1.0.1", "1.0.0"), schema: 2 },
      { ...notes("1.0.1", "v1.0.0") },
      notes("1.0.2", "1.0.0"),
    ];
    for (const asset of cases) {
      const store = new ReleaseNotes({
        baseUrl: BASE,
        cacheDir: null,
        fetch: github({ "1.0.1": asset }).fetch,
      });
      expect((await store.range("1.0.0", "1.0.1")).status).toBe("failed");
    }
  });

  it("is partial when an older release's notes fail to download", async () => {
    const { fetch } = github({
      "1.0.2": notes("1.0.2", "1.0.1"),
      "1.0.1": new TypeError("fetch failed"),
    });
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch });
    const range = await store.range("1.0.0", "1.0.2");
    expect(range.status).toBe("partial");
    expect(range.coveredFrom).toBe("1.0.1");
  });

  it("downloads a release once, and reads it from disk after a restart", async () => {
    const dir = cacheDir();
    const first = github({ "1.0.1": notes("1.0.1", "1.0.0") });
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: dir, fetch: first.fetch });
    await store.range("1.0.0", "1.0.1");
    await store.range("1.0.0", "1.0.1");
    expect(first.requested).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "1.0.1.json"), "utf8")).version).toBe("1.0.1");

    const offline = github({});
    const restarted = new ReleaseNotes({ baseUrl: BASE, cacheDir: dir, fetch: offline.fetch });
    expect((await restarted.range("1.0.0", "1.0.1")).status).toBe("complete");
    expect(offline.requested).toHaveLength(0);
  });

  it("is partial, not an error, when an older release names a malformed previous version", async () => {
    const { fetch } = github({
      "1.0.3": notes("1.0.3", "1.0.2"),
      "1.0.2": notes("1.0.2", "v1.0.1"),
    });
    const dir = cacheDir();
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: dir, fetch });

    const range = await store.range("1.0.0", "1.0.3");

    expect(range.status).toBe("partial");
    expect(range.coveredFrom).toBe("1.0.2");
    // The unreadable file is not kept.
    expect(() => readFileSync(join(dir, "1.0.2.json"))).toThrow();
  });

  it("ignores a cached file it cannot read and downloads again", async () => {
    const dir = cacheDir();
    writeFileSync(join(dir, "1.0.1.json"), JSON.stringify({ schema: 2 }));
    const { fetch, requested } = github({ "1.0.1": notes("1.0.1", "1.0.0") });
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: dir, fetch });
    expect((await store.range("1.0.0", "1.0.1")).status).toBe("complete");
    expect(requested).toHaveLength(1);
  });

  it("asks again for a missing release once its miss expires", async () => {
    let now = 0;
    const assets: Record<string, unknown> = {};
    const { fetch, requested } = github(assets);
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch, now: () => now });
    expect((await store.range(null, "1.0.1")).status).toBe("missing");
    expect((await store.range(null, "1.0.1")).status).toBe("missing");
    expect(requested).toHaveLength(1);

    assets["1.0.1"] = notes("1.0.1", "1.0.0");
    now += 11 * 60_000;
    expect((await store.range(null, "1.0.1")).status).toBe("complete");
  });
});
