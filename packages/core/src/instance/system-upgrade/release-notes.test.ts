import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import type { ReleaseNotesFile } from "@rome/api-types/release-notes";
import {
  compareVersions,
  REFRESH_WITHOUT_HIGHLIGHTS_MS,
  ReleaseNotes,
  REVALIDATE_MS,
} from "./release-notes.js";

/** Ages a kept file on disk by `ms`. */
function age(dir: string, version: string, ms: number) {
  const at = new Date(Date.now() - ms);
  utimesSync(join(dir, `${version}.json`), at, at);
}

const BASE = "https://notes.test/download";

function notes(
  version: string,
  previousVersion: string | null,
  extra: Partial<ReleaseNotesFile> = {},
) {
  return {
    schema: 2,
    version,
    previousVersion,
    date: "2026-11-18T00:00:00Z",
    url: `https://github.com/rome-os/rome/releases/tag/v${version}`,
    breaking: [],
    new: [],
    fixes: [],
    internal: 0,
    highlights: { en: [], zh: [] },
    ...extra,
  } satisfies ReleaseNotesFile;
}

/** A file with one English highlight for pull request 9. */
function withHighlight(version: string, text: string, previousVersion = "1.0.0") {
  return notes(version, previousVersion, {
    new: [{ scope: null, text: "x", pr: 9 }],
    highlights: { en: [{ text, pr: 9 }], zh: [] },
  });
}

/** A schema 1 file: the same fields, without highlights. */
function schemaOne(version: string, previousVersion: string | null) {
  const { highlights: _, ...rest } = notes(version, previousVersion);
  return { ...rest, schema: 1 };
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
  it("walks back to the running version, covering each release on the way", async () => {
    const { fetch } = github({
      "1.1.210": notes("1.1.210", "1.1.209"),
      "1.1.209": notes("1.1.209", "1.1.207"),
      "1.1.207": notes("1.1.207", "1.1.206"),
    });
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch });

    const range = await store.range("1.1.208", "1.1.210");

    expect(range.status).toBe("complete");
    expect(range.releases.map((r) => r.version)).toEqual(["1.1.210", "1.1.209"]);
    expect(range.coveredFrom).toBe("1.1.207");
    expect(range.compareUrl).toBe("https://github.com/rome-os/rome/compare/v1.1.208...v1.1.210");
    expect(Object.keys(range).sort()).toEqual([
      "compareUrl",
      "coveredFrom",
      "from",
      "highlights",
      "releaseUrl",
      "releases",
      "status",
      "to",
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
      "1.1.210": notes("1.1.210", "1.1.209", {
        new: [{ scope: "web", text: "a", pr: 9 }],
        highlights: { en: [{ text: "A.", pr: 9 }], zh: [] },
      }),
    });
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch });

    const range = await store.range("1.1.200", "1.1.210");

    expect(range.status).toBe("partial");
    expect(range.coveredFrom).toBe("1.1.209");
    expect(range.highlights.en).toHaveLength(1);
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
      { ...notes("1.0.1", "1.0.0"), schema: 3 },
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

  it("merges highlights newest first, one per pull request, flagging breaking ones", async () => {
    const { fetch } = github({
      "1.0.3": notes("1.0.3", "1.0.2", {
        new: [{ scope: "web", text: "a", pr: 5 }],
        highlights: {
          en: [{ text: "Dictate messages.", pr: 5 }],
          zh: [{ text: "语音输入消息。", pr: 5 }],
        },
      }),
      "1.0.2": schemaOne("1.0.2", "1.0.1"),
      "1.0.1": notes("1.0.1", "1.0.0", {
        breaking: [{ scope: "core", text: "b", pr: 3 }],
        new: [{ scope: "web", text: "c", pr: 5 }],
        highlights: {
          en: [
            { text: "Sign in again after upgrading.", pr: 3 },
            { text: "Older wording.", pr: 5 },
          ],
          zh: [],
        },
      }),
    });
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch });

    const range = await store.range("1.0.0", "1.0.3");

    expect(range.status).toBe("complete");
    expect(range.highlights.en).toEqual([
      { text: "Dictate messages.", pr: 5, version: "1.0.3", breaking: false },
      { text: "Sign in again after upgrading.", pr: 3, version: "1.0.1", breaking: true },
    ]);
    expect(range.highlights.zh).toEqual([
      { text: "语音输入消息。", pr: 5, version: "1.0.3", breaking: false },
    ]);
  });

  it("refreshes a file without highlights after an hour, in the background, keeping it on failure", async () => {
    let now = 0;
    const assets: Record<string, unknown> = { "1.0.1": schemaOne("1.0.1", "1.0.0") };
    const { fetch, requested } = github(assets);
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch, now: () => now });
    expect((await store.range(null, "1.0.1")).highlights.en).toEqual([]);
    await store.range(null, "1.0.1");
    expect(requested).toHaveLength(1);

    now += REFRESH_WITHOUT_HIGHLIGHTS_MS + 1;
    assets["1.0.1"] = new TypeError("fetch failed");
    expect((await store.range(null, "1.0.1")).status).toBe("complete");
    await store.whenIdle();
    expect(requested).toHaveLength(2);
    await store.range(null, "1.0.1");
    expect(requested).toHaveLength(2);

    now += REFRESH_WITHOUT_HIGHLIGHTS_MS + 1;
    assets["1.0.1"] = withHighlight("1.0.1", "Backfilled.");
    // The kept copy answers while the refresh runs, and the next read has it.
    expect((await store.range(null, "1.0.1")).highlights.en).toEqual([]);
    await store.whenIdle();
    expect((await store.range(null, "1.0.1")).highlights.en[0]?.text).toBe("Backfilled.");
  });

  it("treats a file whose highlights are empty like one without them", async () => {
    let now = 0;
    const assets: Record<string, unknown> = { "1.0.1": notes("1.0.1", "1.0.0") };
    const { fetch } = github(assets);
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch, now: () => now });
    await store.range(null, "1.0.1");
    assets["1.0.1"] = withHighlight("1.0.1", "Backfilled.");
    now += REFRESH_WITHOUT_HIGHLIGHTS_MS + 1;
    await store.range(null, "1.0.1");
    await store.whenIdle();
    expect((await store.range(null, "1.0.1")).highlights.en[0]?.text).toBe("Backfilled.");

    const dir = cacheDir();
    const first = github({ "1.0.1": notes("1.0.1", "1.0.0") });
    await new ReleaseNotes({ baseUrl: BASE, cacheDir: dir, fetch: first.fetch }).range(
      null,
      "1.0.1",
    );
    age(dir, "1.0.1", REFRESH_WITHOUT_HIGHLIGHTS_MS + 60_000);
    const later = github({ "1.0.1": withHighlight("1.0.1", "Backfilled.") });
    const restarted = new ReleaseNotes({ baseUrl: BASE, cacheDir: dir, fetch: later.fetch });
    await restarted.range(null, "1.0.1");
    await restarted.whenIdle();
    expect(later.requested).toHaveLength(1);
  });

  it("refreshes a file with highlights after a day, so a corrected backfill arrives", async () => {
    let now = 0;
    const assets: Record<string, unknown> = { "1.0.1": withHighlight("1.0.1", "First wording.") };
    const { fetch, requested } = github(assets);
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch, now: () => now });
    await store.range(null, "1.0.1");
    now += REVALIDATE_MS - 1;
    await store.range(null, "1.0.1");
    await store.whenIdle();
    expect(requested).toHaveLength(1);

    assets["1.0.1"] = withHighlight("1.0.1", "Corrected wording.");
    now += 2;
    await store.range(null, "1.0.1");
    await store.whenIdle();
    expect((await store.range(null, "1.0.1")).highlights.en[0]?.text).toBe("Corrected wording.");

    // A failed or missing download keeps the copy in hand.
    for (const asset of [500, undefined]) {
      now += REVALIDATE_MS + 1;
      if (asset === undefined) delete assets["1.0.1"];
      else assets["1.0.1"] = asset;
      await store.range(null, "1.0.1");
      await store.whenIdle();
      expect((await store.range(null, "1.0.1")).highlights.en[0]?.text).toBe("Corrected wording.");
    }
  });

  it("answers from kept copies without waiting on a slow refresh", async () => {
    let now = 0;
    const assets: Record<string, unknown> = {};
    for (let patch = 1; patch <= 4; patch += 1) {
      assets[`1.0.${patch}`] = notes(`1.0.${patch}`, `1.0.${patch - 1}`, {
        new: [{ scope: null, text: "x", pr: patch }],
        highlights: { en: [{ text: `Change ${patch}.`, pr: patch }], zh: [] },
      });
    }
    const online = github(assets);
    let slow = false;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!slow) return online.fetch(input, init);
      // Never answers, as an unreachable server would until its timeout.
      return new Promise<Response>(() => {});
    }) as typeof globalThis.fetch;
    const store = new ReleaseNotes({ baseUrl: BASE, cacheDir: null, fetch, now: () => now });
    expect((await store.range("1.0.0", "1.0.4")).releases).toHaveLength(4);

    slow = true;
    now += REVALIDATE_MS + 1;
    const range = await store.range("1.0.0", "1.0.4");
    expect(range.status).toBe("complete");
    expect(range.highlights.en).toHaveLength(4);
  });

  it("refreshes after a restart once the file kept on disk is past its interval", async () => {
    const dir = cacheDir();
    const first = github({ "1.0.1": withHighlight("1.0.1", "First wording.") });
    await new ReleaseNotes({ baseUrl: BASE, cacheDir: dir, fetch: first.fetch }).range(
      null,
      "1.0.1",
    );

    const early = github({});
    const soon = new ReleaseNotes({ baseUrl: BASE, cacheDir: dir, fetch: early.fetch });
    await soon.range(null, "1.0.1");
    await soon.whenIdle();
    expect(early.requested).toHaveLength(0);

    age(dir, "1.0.1", REVALIDATE_MS + 60_000);
    const corrected = github({ "1.0.1": withHighlight("1.0.1", "Corrected wording.") });
    const restarted = new ReleaseNotes({ baseUrl: BASE, cacheDir: dir, fetch: corrected.fetch });
    expect((await restarted.range(null, "1.0.1")).highlights.en[0]?.text).toBe("First wording.");
    await restarted.whenIdle();
    expect((await restarted.range(null, "1.0.1")).highlights.en[0]?.text).toBe(
      "Corrected wording.",
    );
    expect(corrected.requested).toHaveLength(1);
  });
});
