// What an upgrade changes, read from the release-notes.json asset each runtime
// release carries (docs/releases.md#github-release). The upgrade dialog asks
// for a range, from the running version to the offered one.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RELEASE_VERSION,
  type ReleaseNotesFile,
  type ReleaseNotesRange,
  type ReleaseNotesRangeEntry,
  type ReleaseNotesRangeHighlight,
  releaseNotesFileSchema,
} from "@rome/api-types/release-notes";
import { createLogger } from "../../logger.js";

const log = createLogger("release-notes");

/** Releases one range walks at most. Older ones are left out and the range is partial. */
export const MAX_RANGE_RELEASES = 30;
const RANGE_BUDGET_MS = 20_000;
const FETCH_TIMEOUT_MS = 8_000;
/** How long a missing asset is believed missing. A backfill may attach it later. */
const MISSING_TTL_MS = 10 * 60_000;
/**
 * How long a file without highlights (schema 1) is used before it is
 * downloaded again: a backfill replaces those assets with ones that have them.
 */
export const REFRESH_WITHOUT_HIGHLIGHTS_MS = 60 * 60_000;
/**
 * How long a file with highlights is used before it is downloaded again, so
 * a backfill that corrects a published file reaches instances within a day.
 */
export const REVALIDATE_MS = 24 * 60 * 60_000;

/**
 * Orders two RELEASE_VERSION strings: negative when `a` is older. A
 * prerelease sorts below its release, and two prereleases of one release
 * compare as strings.
 */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((version) => RELEASE_VERSION.exec(version));
  if (!x || !y) throw new Error(`not a release version: ${x ? b : a}`);
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return diff;
  }
  const [px, py] = [x[4] ?? "", y[4] ?? ""];
  if (px === py) return 0;
  if (!px) return 1;
  if (!py) return -1;
  return px < py ? -1 : 1;
}

type Lookup =
  | { kind: "found"; notes: ReleaseNotesFile }
  | { kind: "missing" }
  | { kind: "failed"; reason: string };

export interface ReleaseNotesOptions {
  /** Assets are read from `<baseUrl>/v<version>/release-notes.json`. */
  baseUrl: string;
  /** The GitHub repository the release and comparison links point at, `owner/name`. */
  repository?: string;
  /** Where read notes are kept across restarts, or null to keep them in memory only. */
  cacheDir: string | null;
  maxReleases?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Downloads, checks and caches each release's notes, and merges a range of
 * them. A read file is kept in memory and in `cacheDir`, and downloaded
 * again once it is older than REVALIDATE_MS, or REFRESH_WITHOUT_HIGHLIGHTS_MS
 * when it has no highlights. The kept copy still answers when that download
 * fails or finds nothing.
 */
export class ReleaseNotes {
  private readonly baseUrl: string;
  private readonly repository: string;
  private readonly cacheDir: string | null;
  private readonly maxReleases: number;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly cached = new Map<string, { notes: ReleaseNotesFile; freshUntil: number }>();
  private readonly missingUntil = new Map<string, number>();
  /** One download per version at a time: concurrent dialogs share it. */
  private readonly inFlight = new Map<string, Promise<Lookup>>();

  constructor(options: ReleaseNotesOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.repository = options.repository ?? "rome-os/rome";
    this.cacheDir = options.cacheDir;
    this.maxReleases = options.maxReleases ?? MAX_RANGE_RELEASES;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * The changes from `from` (exclusive) up to `to`, walking each release's
   * previousVersion back from `to`. With `from` null, only `to`'s own
   * release. Both are RELEASE_VERSION strings, and `from` is older than `to`.
   * Never throws: a download failure is the `failed` status, or `partial`
   * once the target's notes are in hand.
   */
  async range(from: string | null, to: string): Promise<ReleaseNotesRange> {
    const deadline = this.now() + RANGE_BUDGET_MS;
    const found: ReleaseNotesFile[] = [];
    let status: ReleaseNotesRange["status"] = "complete";
    let version = to;
    while (true) {
      if (found.length >= this.maxReleases || this.now() >= deadline) {
        status = "partial";
        break;
      }
      const lookup = await this.lookup(version, deadline);
      if (lookup.kind !== "found") {
        if (found.length === 0) {
          return this.result(from, to, lookup.kind === "missing" ? "missing" : "failed", []);
        }
        status = "partial";
        break;
      }
      found.push(lookup.notes);
      if (from === null) break;
      const previous = lookup.notes.previousVersion;
      // A null predecessor marks a release whose notes could not say what
      // came before it, not the start of history, so coverage back to
      // `from` is unknown.
      if (previous === null) {
        status = "partial";
        break;
      }
      if (compareVersions(previous, from) <= 0) break;
      // A file whose previousVersion is not older would walk in a circle.
      if (compareVersions(previous, version) >= 0) {
        status = "partial";
        break;
      }
      version = previous;
    }
    return this.result(from, to, status, found);
  }

  private result(
    from: string | null,
    to: string,
    status: ReleaseNotesRange["status"],
    found: ReleaseNotesFile[],
  ): ReleaseNotesRange {
    const highlights = {
      en: this.mergeHighlights(found, "en"),
      zh: this.mergeHighlights(found, "zh"),
    };
    // One entry per pull request: the newest release's, whatever its
    // section there. Within one release a breaking entry wins over new, and
    // new over fixes. `found` is newest first, so each section keeps that order.
    const seen = new Set<number>();
    const merged: Record<"breaking" | "new" | "fixes", ReleaseNotesRangeEntry[]> = {
      breaking: [],
      new: [],
      fixes: [],
    };
    for (const notes of found) {
      for (const section of ["breaking", "new", "fixes"] as const) {
        for (const entry of notes[section]) {
          if (entry.pr !== null) {
            if (seen.has(entry.pr)) continue;
            seen.add(entry.pr);
          }
          merged[section].push({ ...entry, version: notes.version });
        }
      }
    }
    return {
      status,
      from,
      to,
      releases: found.map(({ version, date, url }) => ({ version, date, url })),
      coveredFrom: found.at(-1)?.previousVersion ?? null,
      breaking: merged.breaking,
      new: merged.new,
      fixes: merged.fixes,
      highlights,
      internal: found.reduce((sum, notes) => sum + notes.internal, 0),
      releaseUrl: `https://github.com/${this.repository}/releases/tag/v${to}`,
      compareUrl: from ? `https://github.com/${this.repository}/compare/v${from}...v${to}` : null,
    };
  }

  /** One highlight per pull request, the newest release's. `found` is newest first. */
  private mergeHighlights(
    found: ReleaseNotesFile[],
    language: "en" | "zh",
  ): ReleaseNotesRangeHighlight[] {
    const seen = new Set<number>();
    const merged: ReleaseNotesRangeHighlight[] = [];
    for (const notes of found) {
      const breaking = new Set(notes.breaking.map((entry) => entry.pr));
      for (const highlight of notes.highlights?.[language] ?? []) {
        if (seen.has(highlight.pr)) continue;
        seen.add(highlight.pr);
        merged.push({ ...highlight, version: notes.version, breaking: breaking.has(highlight.pr) });
      }
    }
    return merged;
  }

  /** Keeps `notes`, read at `readAt`, until its refresh interval ends. */
  private remember(version: string, notes: ReleaseNotesFile, readAt = this.now()): number {
    const freshUntil = readAt + (notes.highlights ? REVALIDATE_MS : REFRESH_WITHOUT_HIGHLIGHTS_MS);
    this.cached.set(version, { notes, freshUntil });
    return freshUntil;
  }

  private async lookup(version: string, deadline: number): Promise<Lookup> {
    const cached = this.cached.get(version);
    if (cached && cached.freshUntil > this.now()) return { kind: "found", notes: cached.notes };
    if (!cached && (this.missingUntil.get(version) ?? 0) > this.now()) return { kind: "missing" };
    const pending = this.inFlight.get(version);
    if (pending) return pending;
    const lookup = this.load(version, deadline).finally(() => this.inFlight.delete(version));
    this.inFlight.set(version, lookup);
    return lookup;
  }

  private async load(version: string, deadline: number): Promise<Lookup> {
    let kept = this.cached.get(version)?.notes ?? null;
    if (!kept) {
      // After a restart the file's age on disk decides whether it is fresh.
      const onDisk = await this.readDisk(version);
      if (onDisk && this.remember(version, onDisk.notes, onDisk.writtenAt) > this.now()) {
        return { kind: "found", notes: onDisk.notes };
      }
      kept = onDisk?.notes ?? null;
    }
    const downloaded = await this.download(version, deadline);
    if (downloaded.kind === "found") {
      this.remember(version, downloaded.notes);
      await this.writeDisk(version, downloaded.notes);
      return downloaded;
    }
    if (kept) {
      // Ask again after the refresh interval, not on every request.
      this.remember(version, kept);
      return { kind: "found", notes: kept };
    }
    return downloaded;
  }

  private async download(version: string, deadline: number): Promise<Lookup> {
    const url = `${this.baseUrl}/v${version}/release-notes.json`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(FETCH_TIMEOUT_MS, deadline - this.now()))),
      });
    } catch (error) {
      log.warn("release notes download failed", { version, error: String(error) });
      return { kind: "failed", reason: "unreachable" };
    }
    if (response.status === 404) {
      this.missingUntil.set(version, this.now() + MISSING_TTL_MS);
      return { kind: "missing" };
    }
    if (!response.ok) {
      log.warn("release notes download failed", { version, status: response.status });
      return { kind: "failed", reason: `status ${response.status}` };
    }
    const parsed = releaseNotesFileSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success || parsed.data.version !== version) {
      log.warn("release notes unreadable", { version });
      return { kind: "failed", reason: "unsupported" };
    }
    return { kind: "found", notes: parsed.data };
  }

  /**
   * The file kept from an earlier read and when it was written, or null when
   * there is none or it no longer parses.
   */
  private async readDisk(
    version: string,
  ): Promise<{ notes: ReleaseNotesFile; writtenAt: number } | null> {
    if (!this.cacheDir) return null;
    try {
      const file = join(this.cacheDir, `${version}.json`);
      const raw = JSON.parse(await readFile(file, "utf8"));
      const parsed = releaseNotesFileSchema.safeParse(raw);
      if (!parsed.success || parsed.data.version !== version) return null;
      return { notes: parsed.data, writtenAt: (await stat(file)).mtimeMs };
    } catch {
      return null;
    }
  }

  private async writeDisk(version: string, notes: ReleaseNotesFile): Promise<void> {
    if (!this.cacheDir) return;
    try {
      await mkdir(this.cacheDir, { recursive: true });
      // Write then rename, so a reader never sees half a file.
      const file = join(this.cacheDir, `${version}.json`);
      await writeFile(`${file}.tmp`, JSON.stringify(notes));
      await rename(`${file}.tmp`, file);
    } catch (error) {
      log.warn("release notes not cached on disk", { version, error: String(error) });
    }
  }
}
