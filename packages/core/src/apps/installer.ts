import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, dirname, extname, join } from "node:path";
import { extract as tarExtract } from "tar";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { getProfileInstalledAppsDir } from "../paths.js";
import {
  appIdToPathSegment,
  appMigrationsTableName,
  ArtifactEntrySchema,
  formatZodIssues,
  hashWorkspace,
  parseAppManifest,
  resolvePathWithinBase,
  safeIsFile,
} from "./packaging/index.js";
import type { AppstoreSource, SpecSource } from "./lockfile.js";
import type { RomeCloudListingClient } from "./rome-cloud-listing-client.js";
import { gcInstalledCache, prepare } from "./prepare.js";
import type { ArtifactKind, ArtifactRef, ResolvedArtifacts } from "./state.js";
import type {
  RomeAppArtifactEntry,
  RomeAppBuildManifest,
  RomeAppManifest,
  ResolvedRomeAppApiMetadata,
  ResolvedRomeAppDbMetadata,
  ResolvedRomeAppWebMetadata,
} from "./types.js";
import { fetchVerifiedStoreBundle, type BundleFetcher } from "./store-bundle.js";
import { createEmptyLegacyArtifactBindings, resolveArtifactId } from "./artifact-id.js";

const ACTIVE_NAME = "active";

export interface MaterializeResult {
  hash: string;
  version: string;
  /** Absolute path to `installed/<appId>/<hash>/`. */
  root: string;
  /** `true` when the hash directory already existed on disk and we only re-pointed `active`. */
  cacheHit: boolean;
}

export type ProbeResult = { ok: true; root: string } | { ok: false; reason: string };

export type ResolveResult =
  | {
      ok: true;
      manifest: RomeAppManifest;
      rootPath: string;
      resolveRoot: string;
      displayName: string;
      iconAbsolutePath: string | undefined;
      artifacts: ResolvedArtifacts;
      web: ResolvedRomeAppWebMetadata | null;
      api: ResolvedRomeAppApiMetadata | null;
      db: ResolvedRomeAppDbMetadata | null;
    }
  | { ok: false; reason: string };

export type ResolveDisplayMetadataResult =
  | {
      ok: true;
      displayName: string;
      iconAbsolutePath: string | undefined;
      includeSource: boolean;
    }
  | { ok: false; reason: string };

type ResolveInstalledManifestResult =
  | { ok: true; manifest: RomeAppManifest; rootPath: string }
  | { ok: false; reason: string };

export type { BundleFetcher } from "./store-bundle.js";

const DEFAULT_BUNDLE_FETCHER: BundleFetcher = async (source) => {
  throw new Error(
    `AppInstaller: no bundleFetcher configured; cannot resolve appstore source ` +
      `(listingId=${source.listingId}, version=${source.version}).`,
  );
};

export interface AppInstallerOptions {
  /** Override for `~/.rome/<profile>/apps/installed`. Tests set this to a tmpdir. */
  installedRoot?: string;
  bundleFetcher?: BundleFetcher;
  /**
   * Used to resolve `AppstoreSource.contentHash` when the caller omits it
   * (e.g. an Agent-driven install that has no way to learn the digest up
   * front). When absent or returns `null`, an appstore install without a
   * caller-supplied `contentHash` fails fast at the byte-level check.
   */
  romeCloudListings?: RomeCloudListingClient;
}

export interface GcInstalledCacheOptions {
  keep: number;
  protectedHashes?: readonly string[];
}

const BuildManifestSchema = z.object({
  entry: z.string().min(1),
  styles: z.array(z.string().min(1)).default([]),
  assetVersion: z.string().regex(/^[0-9a-f]{12}$/),
  displayName: z.string().min(1),
  navLabel: z.string().min(1).optional(),
  routing: z.literal("client"),
});

function normalizeArtifactEntry(entry: z.infer<typeof ArtifactEntrySchema>): RomeAppArtifactEntry {
  return typeof entry === "string" ? { path: entry } : entry;
}

/**
 * AppInstaller: pure disk-side bundle materialization. Knows nothing about the
 * lockfile, the catalog, or in-flight ops. Inputs are `(appId, source)`,
 * outputs are content-addressed bundles + manifest resolution.
 */
export class AppInstaller {
  private readonly installedRoot: string;
  private readonly bundleFetcher: BundleFetcher;
  private readonly romeCloudListings: RomeCloudListingClient | undefined;

  constructor(opts: AppInstallerOptions = {}) {
    this.installedRoot = opts.installedRoot ?? getProfileInstalledAppsDir();
    this.bundleFetcher = opts.bundleFetcher ?? DEFAULT_BUNDLE_FETCHER;
    this.romeCloudListings = opts.romeCloudListings;
  }

  /**
   * Materialize `source` to `installed/<appId>/<hash>/`, then atomic-swap
   * `installed/<appId>/active` to point at it.
   *
   * Consumes packed inputs only (`bundle` / `appstore`). A `source`-mode spec
   * is the manager's job to build + pack into a bundle before calling here —
   * receiving one means that stage was skipped, so fail loudly.
   *
   * Caller must serialize concurrent calls for the same appId — installer
   * does not own a per-app mutex. Different appIds may run in parallel.
   */
  async materialize(appId: string, source: SpecSource): Promise<MaterializeResult> {
    if (source.mode === "source") {
      throw new Error(
        `AppInstaller.materialize("${appId}") received a source-mode spec; ` +
          `AppManager must build + pack it into a bundle first`,
      );
    }
    const beforeRoot = await this.readActiveTarget(appId);
    const prepared =
      source.mode === "appstore"
        ? await this.materializeAppstore(appId, source)
        : await prepare(
            {
              kind: "artifact",
              appId,
              artifactRoot: source.path,
            },
            { installedRoot: this.installedRoot },
          );

    await this.swapActive(appId, prepared.hash);

    const cacheHit = beforeRoot != null && basename(beforeRoot) === prepared.hash;
    return {
      hash: prepared.hash,
      version: prepared.version,
      root: prepared.root,
      cacheHit,
    };
  }

  /**
   * Resolve the digest we expect the fetched bundle bytes to match. Caller
   * may pin via `source.contentHash`; otherwise we ask Rome Cloud's listing
   * detail (the same authoritative row written at publish time). The
   * resulting hash is also what gets sealed into the on-disk extracted dir,
   * so subsequent reconciles probe by it.
   *
   * Security tradeoff when `contentHash` is omitted: the daemon fetches both
   * the hash (via `romeCloudListings.getContentHash`) and the bundle (via
   * `bundleFetcher`) from the same Rome Cloud registry, so a network-level
   * attacker on the daemon's outbound path can serve a matched malicious
   * pair without an independent client-side check. Callers that already
   * hold the digest from an independent path (e.g. a dashboard that fetched
   * the listing detail before constructing the install request) should
   * always pass `contentHash` to keep that second trust anchor. Omitting it
   * is intended for agent-driven installs that have no separate channel.
   */
  private async resolveExpectedHash(appId: string, source: AppstoreSource): Promise<string> {
    if (source.contentHash !== undefined) return source.contentHash.toLowerCase();
    if (!this.romeCloudListings) {
      throw new Error(
        `App-store install for "${appId}" omitted contentHash, but no listing client ` +
          `is configured on the installer to resolve it.`,
      );
    }
    const resolved = await this.romeCloudListings.getContentHash(source.listingId, source.version);
    if (resolved == null) {
      throw new Error(
        `App-store install for "${appId}" omitted contentHash, and the registry ` +
          `did not return a contentHash for listingId=${source.listingId} ` +
          `version=${source.version} (not found, revoked, or unreachable).`,
      );
    }
    return resolved.toLowerCase();
  }

  /**
   * Extracted dir lives at `installed/<appId>/.extract-<hash>-<rand>/` so
   * `sweepStaging` cleans orphans from a crash mid-extract.
   */
  private async materializeAppstore(
    appId: string,
    source: AppstoreSource,
  ): Promise<Awaited<ReturnType<typeof prepare>>> {
    const expected = await this.resolveExpectedHash(appId, source);
    const bytes = await fetchVerifiedStoreBundle(appId, source, expected, this.bundleFetcher);

    const appInstalledRoot = join(this.installedRoot, appIdToPathSegment(appId));
    await mkdir(appInstalledRoot, { recursive: true });
    const extractedRoot = await mkdtemp(join(appInstalledRoot, `.extract-${expected}-`));
    try {
      try {
        await pipeline(Readable.from(bytes), tarExtract({ cwd: extractedRoot, strip: 1 }));
      } catch (err) {
        throw new Error(
          `Failed to extract app-store bundle for "${appId}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return await prepare(
        { kind: "sealed", appId, extractedRoot, contentHash: expected },
        { installedRoot: this.installedRoot },
      );
    } finally {
      await rm(extractedRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Atomically point `installed/<appId>/active` at `<hash>/`. */
  private async swapActive(appId: string, hash: string): Promise<void> {
    const appDir = join(this.installedRoot, appIdToPathSegment(appId));
    await mkdir(appDir, { recursive: true });
    const activePath = join(appDir, ACTIVE_NAME);
    const tmpPath = join(appDir, `.${ACTIVE_NAME}.tmp.${process.pid}.${Date.now()}`);
    await unlink(tmpPath).catch(() => {});
    await symlink(hash, tmpPath);
    await rename(tmpPath, activePath);
  }

  async readActiveTarget(appId: string): Promise<string | null> {
    const activePath = join(this.installedRoot, appIdToPathSegment(appId), ACTIVE_NAME);
    try {
      const target = await readlink(activePath);
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async tearDown(appId: string): Promise<void> {
    const appDir = join(this.installedRoot, appIdToPathSegment(appId));
    await rm(appDir, { recursive: true, force: true });
  }

  /**
   * Clean up staging dirs left behind by a crash mid-`prepare()`. Matches
   * `installed/<appId>/.staging-*`. Returns the absolute paths swept.
   */
  async sweepStaging(appId: string): Promise<string[]> {
    const appDir = join(this.installedRoot, appIdToPathSegment(appId));
    if (!existsSync(appDir)) return [];
    let entries: string[];
    try {
      entries = await readdir(appDir);
    } catch {
      return [];
    }
    const swept: string[] = [];
    for (const name of entries) {
      if (
        !name.startsWith(".staging-") &&
        !name.startsWith(".extract-") &&
        !name.startsWith(`.${ACTIVE_NAME}.tmp.`)
      ) {
        continue;
      }
      const full = join(appDir, name);
      await rm(full, { recursive: true, force: true });
      swept.push(full);
    }
    return swept;
  }

  async gcInstalledCache(appId: string, opts: GcInstalledCacheOptions): Promise<void> {
    await gcInstalledCache(this.installedRoot, appId, opts.keep, opts.protectedHashes ?? []);
  }

  /** Verify `active` symlink exists and resolves to `<expectedHash>/app.yaml`. */
  async probe(appId: string, expectedHash: string): Promise<ProbeResult> {
    const appDir = join(this.installedRoot, appIdToPathSegment(appId));
    const activePath = join(appDir, ACTIVE_NAME);
    let target: string;
    try {
      target = await readlink(activePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: false, reason: `active symlink missing at ${activePath}` };
      }
      return { ok: false, reason: `readlink(${activePath}) failed: ${(err as Error).message}` };
    }
    const targetName = basename(target);
    if (targetName !== expectedHash) {
      return {
        ok: false,
        reason: `active symlink points at ${targetName}, expected ${expectedHash}`,
      };
    }
    const root = join(appDir, expectedHash);
    if (!existsSync(join(root, "app.yaml"))) {
      return { ok: false, reason: `bundle missing app.yaml at ${root}` };
    }
    return { ok: true, root };
  }

  /** Convenience for testing and migration scripts. */
  computeWorkspaceHash(workspaceRoot: string): Promise<string> {
    return hashWorkspace(workspaceRoot);
  }

  /**
   * Read the manifest at `installed/<appId>/active/app.yaml` and assemble the
   * resolved artifact list + web/api/db metadata. Manifest lookup and parsing
   * failures return `{ ok: false }`; runtime path and artifact resolution may
   * throw.
   */
  async resolve(appId: string): Promise<ResolveResult> {
    const installedManifest = await this.resolveInstalledManifest(appId);
    if (!installedManifest.ok) return installedManifest;
    const { manifest, rootPath } = installedManifest;

    const resolveRoot = manifest.appRoot
      ? resolvePathWithinBase(rootPath, manifest.appRoot, `appRoot for app "${appId}"`)
      : rootPath;

    const iconAbsolutePath = manifest.icon
      ? resolvePathWithinBase(resolveRoot, manifest.icon, `icon for app "${appId}"`)
      : undefined;

    const artifacts: ResolvedArtifacts = {
      agent: this.resolveArtifactKind(manifest, resolveRoot, "agent"),
      action: this.resolveArtifactKind(manifest, resolveRoot, "action"),
      skill: this.resolveArtifactKind(manifest, resolveRoot, "skill"),
      hook: this.resolveArtifactKind(manifest, resolveRoot, "hook"),
    };

    let web: ResolvedRomeAppWebMetadata | null = null;
    if (manifest.web) {
      web = await this.resolveWeb(appId, resolveRoot, manifest);
    }

    let api: ResolvedRomeAppApiMetadata | null = null;
    if (manifest.api) {
      api = await this.resolveApi(appId, resolveRoot, manifest);
    }

    let db: ResolvedRomeAppDbMetadata | null = null;
    if (manifest.db) {
      db = this.resolveDb(appId, resolveRoot, manifest);
    }

    return {
      ok: true,
      manifest,
      rootPath,
      resolveRoot,
      displayName: manifest.name ?? manifest.id,
      iconAbsolutePath,
      artifacts,
      web,
      api,
      db,
    };
  }

  /**
   * Read only the installed manifest fields needed by passive UI surfaces.
   * Unlike full runtime resolution, this does not inspect declared artifacts,
   * web/API entrypoints, or DB migrations. Every disk and validation failure
   * is returned as `{ ok: false }` so disabled apps can remain unloaded.
   */
  async resolveDisplayMetadata(appId: string): Promise<ResolveDisplayMetadataResult> {
    try {
      const installedManifest = await this.resolveInstalledManifest(appId);
      if (!installedManifest.ok) return installedManifest;
      const { manifest, rootPath } = installedManifest;
      const resolveRoot = manifest.appRoot
        ? resolvePathWithinBase(rootPath, manifest.appRoot, `appRoot for app "${appId}"`)
        : rootPath;
      const iconCandidate = manifest.icon
        ? resolvePathWithinBase(resolveRoot, manifest.icon, `icon for app "${appId}"`)
        : undefined;

      return {
        ok: true,
        displayName: manifest.name ?? manifest.id,
        iconAbsolutePath:
          iconCandidate !== undefined && safeIsFile(iconCandidate) ? iconCandidate : undefined,
        includeSource: manifest.includeSource === true,
      };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async resolveInstalledManifest(appId: string): Promise<ResolveInstalledManifestResult> {
    const appDir = join(this.installedRoot, appIdToPathSegment(appId));
    const activePath = join(appDir, ACTIVE_NAME);
    if (!existsSync(activePath)) {
      return { ok: false, reason: `active symlink missing for app "${appId}"` };
    }

    let rootPath: string;
    try {
      const stats = await stat(activePath);
      if (!stats.isDirectory()) {
        return { ok: false, reason: `active target for "${appId}" is not a directory` };
      }
      const target = await readlink(activePath);
      rootPath = target.startsWith("/") ? target : join(appDir, target);
    } catch (err) {
      return { ok: false, reason: `cannot stat active for "${appId}": ${(err as Error).message}` };
    }

    const manifestPath = join(rootPath, "app.yaml");
    if (!existsSync(manifestPath)) {
      return { ok: false, reason: `manifest missing at ${manifestPath}` };
    }

    let manifest: RomeAppManifest;
    try {
      manifest = await this.readManifest(manifestPath, appId);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    return { ok: true, manifest, rootPath };
  }

  private async readManifest(
    manifestPath: string,
    expectedAppId: string,
  ): Promise<RomeAppManifest> {
    const raw = await readFile(manifestPath, "utf-8");
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      throw new Error(`Failed to parse app manifest ${manifestPath}: ${(err as Error).message}`);
    }
    const data = parseAppManifest(parsed, manifestPath);
    if (data.id !== expectedAppId) {
      throw new Error(
        `Manifest id "${data.id}" at ${manifestPath} does not match installed app "${expectedAppId}"`,
      );
    }
    return {
      formatVersion: data.formatVersion,
      id: data.id,
      version: data.version,
      description: data.description,
      tagline: data.tagline,
      name: data.name,
      icon: data.icon,
      appRoot: data.appRoot,
      includeSource: data.includeSource,
      remix: data.remix,
      agents: (data.agents ?? []).map(normalizeArtifactEntry),
      actions: (data.actions ?? []).map(normalizeArtifactEntry),
      skills: (data.skills ?? []).map(normalizeArtifactEntry),
      hooks: (data.hooks ?? []).map(normalizeArtifactEntry),
      components: data.components ?? [],
      web: data.web,
      api: data.api,
      db: data.db,
      suggestedChannelBindings:
        data.formatVersion === 2
          ? data.suggestedChannelBindings?.map((binding) => ({
              ...binding,
              agent: resolveArtifactId({
                kind: "agent",
                value: binding.agent,
                legacyBindings: createEmptyLegacyArtifactBindings(),
              }),
            }))
          : data.suggestedChannelBindings,
    };
  }

  private resolveArtifactKind(
    manifest: RomeAppManifest,
    resolveRoot: string,
    kind: ArtifactKind,
  ): ArtifactRef[] {
    const entries = this.manifestEntriesFor(manifest, kind);
    return entries.map((entry) => {
      const absolutePath = resolvePathWithinBase(
        resolveRoot,
        entry.path,
        `${kind} path for app "${manifest.id}"`,
      );
      if (!existsSync(absolutePath)) {
        throw new Error(`App "${manifest.id}" ${kind} artifact missing on disk: ${absolutePath}`);
      }
      const publicName = entry.publicName ?? defaultPublicName(entry.path, kind);
      return {
        formatVersion: manifest.formatVersion,
        kind,
        publicName,
        aliases: entry.aliases ?? [],
        ownerType: "app" as const,
        ownerId: manifest.id,
        absolutePath,
      };
    });
  }

  private manifestEntriesFor(
    manifest: RomeAppManifest,
    kind: ArtifactKind,
  ): RomeAppArtifactEntry[] {
    if (kind === "agent") return manifest.agents;
    if (kind === "action") return manifest.actions;
    if (kind === "skill") return manifest.skills;
    return manifest.hooks;
  }

  private async resolveWeb(
    appId: string,
    resolveRoot: string,
    manifest: RomeAppManifest,
  ): Promise<ResolvedRomeAppWebMetadata> {
    const declaration = manifest.web;
    if (!declaration) {
      throw new Error(`App "${appId}" does not declare a web bundle`);
    }
    const manifestPath = resolvePathWithinBase(
      resolveRoot,
      declaration.manifest,
      `web manifest for app "${appId}"`,
    );
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch {
      throw new Error(
        `App "${appId}" declares web.manifest at "${declaration.manifest}", but ${manifestPath} was not found.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Invalid app web manifest for "${appId}" in ${manifestPath}: ${(err as Error).message}`,
      );
    }
    const result = BuildManifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid app web manifest for "${appId}" in ${manifestPath}:\n${formatZodIssues(result.error)}`,
      );
    }
    const buildManifest = result.data as RomeAppBuildManifest;
    const distPath = dirname(manifestPath);
    resolvePathWithinBase(distPath, buildManifest.entry, `web entry for app "${appId}"`);
    for (const stylePath of buildManifest.styles) {
      resolvePathWithinBase(distPath, stylePath, `web stylesheet for app "${appId}"`);
    }
    return {
      appId,
      version: manifest.version,
      manifestPath,
      distPath,
      ...buildManifest,
      navLabel: buildManifest.navLabel ?? buildManifest.displayName,
    };
  }

  private async resolveApi(
    appId: string,
    resolveRoot: string,
    manifest: RomeAppManifest,
  ): Promise<ResolvedRomeAppApiMetadata> {
    const declaration = manifest.api;
    if (!declaration) {
      throw new Error(`App "${appId}" does not declare an API entrypoint`);
    }
    const entry = declaration.entry ?? "api/index";
    const entryPath = resolveModuleEntryPath(resolveRoot, entry, appId);
    return {
      appId,
      entryPath,
      noAuth: declaration.noAuth ?? false,
      relayWebhook: declaration.relayWebhook ?? null,
    };
  }

  private resolveDb(
    appId: string,
    resolveRoot: string,
    manifest: RomeAppManifest,
  ): ResolvedRomeAppDbMetadata {
    const declaration = manifest.db;
    if (!declaration) {
      throw new Error(`App "${appId}" does not declare DB assets`);
    }
    const migrationsPath = resolvePathWithinBase(
      resolveRoot,
      declaration.migrations,
      `DB migrations for app "${appId}"`,
    );
    if (!existsSync(join(migrationsPath, "meta", "_journal.json"))) {
      throw new Error(
        `App "${appId}" DB migrations journal missing at ${migrationsPath}/meta/_journal.json`,
      );
    }
    const tablePrefix = declaration.tablePrefix ?? appId;
    return {
      appId,
      migrationsPath,
      migrationsTable: appMigrationsTableName(tablePrefix),
      tablePrefix,
    };
  }
}

function defaultPublicName(relPath: string, kind: ArtifactKind): string {
  const filename = basename(relPath);
  const stem = filename.replace(extname(filename), "");
  if (kind === "skill") {
    // Skills are dirs; the public name is the dir name.
    return basename(relPath);
  }
  return stem;
}

function resolveModuleEntryPath(resolveRoot: string, entry: string, appId: string): string {
  const base = resolvePathWithinBase(resolveRoot, entry, `API entrypoint for app "${appId}"`);
  for (const ext of [".js", ".mjs", ".cjs", ".ts"]) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  if (existsSync(base)) return base;
  throw new Error(
    `App "${appId}" API entrypoint not found: tried ${base} with .js/.mjs/.cjs/.ts extensions`,
  );
}
