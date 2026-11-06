// Remembers each app action's input schema across boots, so boot can register
// an action from an unchanged bundle without importing its module.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { createLogger } from "../logger.js";

const log = createLogger("app-action-schema-cache");

const cacheFileSchema = z.object({
  build: z.string(),
  entries: z.record(
    z.string(),
    z.object({ inputSchema: z.record(z.string(), z.unknown()).nullable() }),
  ),
});

/** What a cache hit knows about an action without importing it. */
export interface CachedActionSchema {
  /** Null for an event-only action, which exposes no input schema. */
  inputSchema: Record<string, unknown> | null;
}

/**
 * Entries are keyed by app id, installed bundle hash, and action name. The
 * bundle hash is content-addressed, so a key never outlives the code it
 * describes. The whole file is dropped when the Rome build changes, because
 * the SDK that turns an action's Zod spec into its input schema ships with
 * Rome.
 */
export class AppActionSchemaCache {
  private readonly entries: Map<string, CachedActionSchema>;
  private readonly seen = new Set<string>();
  private dirty = false;

  private constructor(
    private readonly path: string,
    private readonly build: string,
    entries: Map<string, CachedActionSchema>,
  ) {
    this.entries = entries;
  }

  /**
   * Reads the cache file at `path`. Returns null when `build` is null, so a
   * build without an identity never trusts a cached schema. A missing,
   * unreadable, or foreign-build file loads as an empty cache.
   */
  static async load(path: string, build: string | null): Promise<AppActionSchemaCache | null> {
    if (!build) return null;
    let entries = new Map<string, CachedActionSchema>();
    try {
      const parsed = cacheFileSchema.safeParse(JSON.parse(await readFile(path, "utf-8")));
      if (parsed.success && parsed.data.build === build) {
        entries = new Map(Object.entries(parsed.data.entries));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("ignoring unreadable app action schema cache", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return new AppActionSchemaCache(path, build, entries);
  }

  /** Returns null when the app has no installed bundle hash to key on. */
  static key(appId: string, installedHash: string | null, actionName: string): string | null {
    return installedHash ? `${appId}\0${installedHash}\0${actionName}` : null;
  }

  get(key: string): CachedActionSchema | undefined {
    const entry = this.entries.get(key);
    if (entry) this.seen.add(key);
    return entry;
  }

  set(key: string, inputSchema: Record<string, unknown> | undefined): void {
    this.entries.set(key, { inputSchema: inputSchema ?? null });
    this.seen.add(key);
    this.dirty = true;
  }

  /**
   * Writes the entries read or written by this process and drops the rest, so
   * uninstalled and upgraded bundles leave the file. Never throws: a failed
   * write costs the next boot its cache hits, not its correctness.
   */
  async save(): Promise<void> {
    for (const key of this.entries.keys()) {
      if (!this.seen.has(key)) {
        this.entries.delete(key);
        this.dirty = true;
      }
    }
    if (!this.dirty) return;
    const entries = Object.fromEntries(this.entries);
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ build: this.build, entries }), "utf-8");
      await rename(tmp, this.path);
      this.dirty = false;
    } catch (err) {
      log.warn("failed to save app action schema cache", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
