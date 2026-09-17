import { dirname, join } from "node:path";
import { Mutex } from "async-mutex";
import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import { createLogger } from "../logger.js";
import { getProjectRoot } from "../paths.js";
import {
  buildSourceWorkspace,
  classifyAppDir,
  hasSourceWorkspaceMarkers,
  isValidAppId,
  packArtifact,
  readManifestIdAndVersion,
  sourceRootForArtifactPath,
  validateInstalledArtifact,
} from "./packaging/index.js";
import {
  APPS_LOCKFILE_SCHEMA_VERSION,
  type AppEntry,
  type AppLockfile,
  emptyLockfile,
  lockfileExists,
  LockfileTopLevelError,
  nowIso,
  readLockfileWithEntryIsolation,
  type SpecSource,
  writeLockfile,
} from "./lockfile.js";
import type { AppCatalog } from "./catalog.js";
import type { AppInstaller } from "./installer.js";
import { migrateToLockfile } from "./migrate-to-lockfile.js";
import { normalizeListingId } from "./rome-cloud-urls.js";
import { validateRemixInstallIsolation } from "./remix-install-validation.js";
import { ManifestIdMismatchError } from "./prepare.js";
import type { AppId, InFlightOp } from "./state.js";
import type { AppManagerErrorCode } from "@rome/api-types/app-manager-errors";

const log = createLogger("app-manager");
const INSTALLED_CACHE_RETAINED_OLD_VERSIONS = 1;

// The codes, and the HTTP status each maps to, are shared so a client can
// predict the response class; the error class itself stays here.
export type { AppManagerErrorCode } from "@rome/api-types/app-manager-errors";

export class AppManagerError extends Error {
  constructor(
    readonly code: AppManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppManagerError";
  }
}

export const SYSTEM_APP_ID = "system";

export interface InstallOpts {
  source: SpecSource;
  /** Default true. Preserves prior value on re-install when omitted. */
  enabled?: boolean;
  /**
   * Marks the app as first-party (shipped with Rome). Only the boot
   * first-party install passes true. When omitted the prior lockfile value is
   * preserved (false on first install), so a user re-install of a first-party
   * bundle never clears the flag.
   */
  firstParty?: boolean;
}

export interface InstallResult {
  /** Derived from the source by the daemon — manifest id locally, canonical listing id for App Store. */
  appId: AppId;
  state: "installed" | "failed";
  installedHash: string | null;
  installedVersion: string | null;
  error: { code: string; message: string } | null;
}

export interface UninstallOpts {
  purge?: boolean;
  /**
   * Permits removing a first-party app. Only the boot reconciler passes true
   * (for apps dropped from the distribution — packed artifact gone); every
   * user-facing entry point leaves it unset and is rejected by the
   * first-party gate. Mirrors `InstallOpts.firstParty`.
   */
  firstParty?: boolean;
}

export interface UninstallResult {
  alreadyAbsent: boolean;
  purged: boolean;
  diskCleanupError: string | null;
}

export interface BootResult {
  appCount: number;
  sweptStaging: string[];
  brokenApps: AppId[];
}

export interface AppManagerOptions {
  lockfilePath: string;
  installer: AppInstaller;
}

/**
 * Sole writer to the apps lockfile. Owns per-app + lockfile mutexes; runs
 * install / uninstall / setEnabled / boot synchronously to terminal state.
 */
export class AppManager {
  private readonly lockfilePath: string;
  private readonly installer: AppInstaller;
  private catalog: AppCatalog | null = null;
  private readonly perAppMutex = new KeyedMutex();
  private readonly lockfileMutex = new Mutex();
  private readonly inFlightOps = new Map<AppId, InFlightOp>();

  constructor(opts: AppManagerOptions) {
    this.lockfilePath = opts.lockfilePath;
    this.installer = opts.installer;
  }

  /** Late-bind the catalog so AppCatalog can be constructed with a back-reference. */
  attachCatalog(catalog: AppCatalog): void {
    this.catalog = catalog;
  }

  async readLockfileEntry(appId: AppId): Promise<AppEntry | null> {
    const { lockfile } = await readLockfileWithEntryIsolation(this.lockfilePath);
    return lockfile.apps[appId] ?? null;
  }

  getInFlight(appId: AppId): InFlightOp | undefined {
    return this.inFlightOps.get(appId);
  }

  async install(opts: InstallOpts): Promise<InstallResult> {
    // The appId is derived from the source, never caller-supplied: manifest id
    // for local sources (read by the fail-fast gate below), canonical listing
    // id for appstore sources (cross-checked against the downloaded bundle's
    // manifest id post-download). Derivation runs before the mutex so the per-app mutex
    // serializes on the derived id. `source` is the canonicalized spec —
    // appstore listingIds in their logical form — and replaces `opts.source`
    // everywhere downstream (in-flight op, lockfile writes, error messages).
    const { source, appId } = await this.resolveInstallTarget(opts.source);
    // The system app may be re-installed (this is how it upgrades), but it must
    // never land in the disabled state — the daemon assumes it is always present
    // and running. Mirrors the guards in `uninstall` / `setEnabled`.
    if (appId === SYSTEM_APP_ID && opts.enabled === false) {
      throw new AppManagerError("SYSTEM_PROTECTED", `app "${appId}" cannot be disabled`);
    }
    return this.perAppMutex.runExclusive(appId, async () => {
      // First-party apps are immutable to users: only boot may (re)install
      // them, and boot is the sole caller that passes `firstParty: true`.
      // Without this gate any caller could replace a shipped app's code by
      // installing a bundle whose manifest reuses its id. Runs before the
      // build pipeline and any state transition, mirroring the uninstall
      // gate below — every install entry point funnels through here.
      const priorEntry = (await this.readLockfileForMutation()).apps[appId];
      if (priorEntry?.firstParty && !opts.firstParty) {
        throw new AppManagerError(
          "FIRST_PARTY_PROTECTED",
          `app "${appId}" is part of the Rome distribution and cannot be replaced. ` +
            `First-party apps update automatically at boot from the packed build artifacts.`,
        );
      }
      // Source-mode installs run the build pipeline first: build the
      // workspace with its own toolchain, pack into the conventional
      // `<repo>/.rome/artifact`, then install that bundle. The lockfile
      // keeps the *source* spec, so every re-install rebuilds; unchanged
      // source converges to a prepare() cache hit via the artifact hash.
      //
      // Build + pack runs BEFORE the `installing` transition below: the
      // build window can be long (the workspace's own `pnpm install` +
      // `pnpm build`), and the previously installed version must stay
      // resolved and running through it. A build/pack failure therefore
      // throws here — no lockfile write, no catalog transition.
      let materializeSource: SpecSource = source;
      if (source.mode === "source") {
        const artifactDir = join(source.path, ".rome", "artifact");
        try {
          await buildSourceWorkspace(source.path, { projectRoot: getProjectRoot() });
          await packArtifact(source.path, artifactDir, { appId, clean: true });
        } catch (err) {
          throw new AppManagerError(
            "ARTIFACT_INVALID",
            err instanceof Error ? err.message : String(err),
          );
        }
        materializeSource = { mode: "bundle", path: artifactDir };
      }
      if (this.catalog) {
        try {
          await validateRemixInstallIsolation(materializeSource, this.catalog, this.installer);
        } catch (err) {
          throw new AppManagerError(
            "ARTIFACT_INVALID",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      const startedAt = nowIso();
      const op: InFlightOp = { kind: "install", source, startedAt };
      this.inFlightOps.set(appId, op);
      try {
        await this.catalog?.refresh(appId);
        const result = await this.installer.materialize(appId, materializeSource);
        // Pin the resolved contentHash when an appstore caller omitted it, so
        // a subsequent `op: install` is deterministic without re-querying the
        // registry. The listingId needs no rewrite here — `source` already
        // carries the canonical logical form (legacy bundle URLs were
        // normalized by the resolve gate), so the on-disk lockfile converges
        // on the convention as installs flow through. Boot reconciliation
        // already probes by `installedHash`; this only affects re-installs.
        const persistedSource: SpecSource =
          source.mode === "appstore"
            ? { ...source, contentHash: source.contentHash ?? result.hash }
            : source;
        await this.lockfileMutex.runExclusive(async () => {
          const lockfile = await this.readLockfileForMutation();
          const prior = lockfile.apps[appId];
          lockfile.apps[appId] = {
            source: persistedSource,
            enabled: opts.enabled ?? prior?.enabled ?? true,
            firstParty: opts.firstParty ?? prior?.firstParty ?? false,
            state: "installed",
            installedHash: result.hash,
            installedVersion: result.version,
            // First successful install stamps the time. A prior entry that
            // already installed once keeps what it recorded, including
            // "absent" for entries older than the field.
            installedAt: prior?.installedHash != null ? prior.installedAt : nowIso(),
            lastError: null,
            updatedAt: nowIso(),
          };
          await writeLockfile(this.lockfilePath, lockfile);
        });
        log.info("app installed", {
          appId,
          hash: result.hash,
          version: result.version,
          cacheHit: result.cacheHit,
        });
        await this.installer.gcInstalledCache(appId, {
          keep: INSTALLED_CACHE_RETAINED_OLD_VERSIONS,
          protectedHashes: [result.hash],
        });
        return {
          appId,
          state: "installed",
          installedHash: result.hash,
          installedVersion: result.version,
          error: null,
        };
      } catch (err) {
        await this.installer.sweepStaging(appId).catch(() => undefined);
        // The downloaded appstore bundle's manifest id disagrees with the id
        // the canonical listing id declares. Recording `failed` would write a lockfile
        // entry under an id the bundle does not actually carry, so this is a
        // gate-class rejection: nothing recorded, prior state untouched.
        if (err instanceof ManifestIdMismatchError) {
          throw new AppManagerError(
            "ARTIFACT_INVALID",
            source.mode === "appstore"
              ? `App Store listing "${source.listingId}" uses app id "${err.expectedId}", ` +
                  `but the downloaded bundle's manifest declares id "${err.actualId}". The registry ` +
                  `listing and the published bundle disagree — refusing to install either. Report ` +
                  `this to the app's publisher; nothing was installed.`
              : `The manifest at ${err.manifestPath} declared id "${err.expectedId}" when this ` +
                  `install started but reads "${err.actualId}" now — the source changed mid-install. ` +
                  `Nothing was installed; re-run the install.`,
          );
        }
        const error = toLastError(err);
        let priorHash: string | null = null;
        let priorVersion: string | null = null;
        await this.lockfileMutex.runExclusive(async () => {
          const lockfile = await this.readLockfileForMutation();
          const prior = lockfile.apps[appId];
          priorHash = prior?.installedHash ?? null;
          priorVersion = prior?.installedVersion ?? null;
          lockfile.apps[appId] = {
            source,
            enabled: opts.enabled ?? prior?.enabled ?? true,
            firstParty: opts.firstParty ?? prior?.firstParty ?? false,
            state: "failed",
            installedHash: priorHash,
            installedVersion: priorVersion,
            installedAt: prior?.installedAt,
            lastError: error,
            updatedAt: nowIso(),
          };
          await writeLockfile(this.lockfilePath, lockfile);
        });
        log.warn("app install failed", {
          appId,
          error: error.message,
          priorHash,
        });
        return {
          appId,
          state: "failed",
          installedHash: priorHash,
          installedVersion: priorVersion,
          error,
        };
      } finally {
        this.inFlightOps.delete(appId);
        await this.catalog?.refresh(appId);
      }
    });
  }

  /**
   * Resolve the canonical source spec and the install appId from the
   * caller's source — the caller never supplies the appId.
   *
   * - `source` / `bundle`: passed through unchanged; the appId is the
   *   manifest id read from `source.path`'s app.yaml, after the fail-fast
   *   shape gate. The manifest schema enforces the app-id grammar.
   * - `appstore`: `listingId` must parse under the listing-id grammar
   *   (listing-id.ts) — legacy Rome Cloud bundle URLs are normalized to their
   *   logical form first, and anything unparseable is rejected here, before
   *   any state is written. The returned source carries the canonical
   *   logical id. That complete canonical id is also the appId; scoped ids are
   *   retained rather than collapsed to their non-unique slug.
   *   This is the *declared* id, used for mutex serialization and early
   *   checks; `prepare()` cross-checks it against the downloaded bundle's
   *   manifest id post-download, and a mismatch is rejected without
   *   recording anything (see the `ManifestIdMismatchError` handling in
   *   `install`).
   */
  private async resolveInstallTarget(
    input: SpecSource,
  ): Promise<{ source: SpecSource; appId: AppId }> {
    if (input.mode === "appstore") {
      const parsed = normalizeListingId(input.listingId);
      if (parsed == null) {
        throw new AppManagerError(
          "INVALID_APP_ID",
          `App Store listingId ${JSON.stringify(input.listingId)} is not a valid listing id. ` +
            `Pass the logical listing id — "xiaohongshu" or "@handle/slug" — not a URL.`,
        );
      }
      const appId = parsed.id;
      if (!isValidAppId(appId)) {
        throw new AppManagerError(
          "INVALID_APP_ID",
          `App Store listing "${input.listingId}" is not a valid app id.`,
        );
      }
      return { source: { ...input, listingId: parsed.id }, appId };
    }
    return { source: input, appId: await this.deriveLocalInstallAppId(input) };
  }

  /**
   * Fail-fast gate for local installs, run before staging, dep install, or
   * any lockfile write — a rejection here leaves prior app state untouched,
   * unlike a failure inside `materialize`, which records `state: "failed"`.
   * Returns the appId read from the directory's manifest.
   *
   * Two independent signals must agree: the caller's *declared* mode
   * (`source` vs `bundle`) and the *observed* shape of the directory
   * (`classifyAppDir`). A mismatch is rejected with the exact next command,
   * never reinterpreted — a stale `.rome/artifact` applied as "source", or a
   * built repo root applied as "bundle", would otherwise silently install
   * the wrong bytes.
   *
   * Appstore sources never reach this gate: their bundles can only be
   * inspected after download, and `prepare()` deep-validates them before
   * commit.
   */
  private async deriveLocalInstallAppId(
    source: SpecSource & { mode: "source" | "bundle" },
  ): Promise<AppId> {
    const kind = classifyAppDir(source.path);
    const appRepo = sourceRootForArtifactPath(source.path);

    if (source.mode === "bundle") {
      switch (kind) {
        case "missing":
          throw new AppManagerError(
            "ARTIFACT_INVALID",
            `Bundle path ${source.path} does not exist. ` +
              (appRepo != null
                ? `To build + install from the app's source repo in one step, install ` +
                  `{ mode: "source", path: "${appRepo}" }.`
                : `Install { mode: "source", path: "<app repo>" } — the daemon builds, ` +
                  `packs, and installs in one step.`),
          );
        case "no-manifest":
          throw new AppManagerError(
            "ARTIFACT_INVALID",
            `${source.path} is not a packed app artifact (no app.yaml). ` +
              (appRepo != null
                ? `Install { mode: "source", path: "${appRepo}" } to build + install in one step.`
                : `Install { mode: "source", path: "<app repo>" } — the daemon builds, ` +
                  `packs, and installs in one step.`),
          );
        case "source": {
          if (hasSourceWorkspaceMarkers(source.path)) {
            throw new AppManagerError(
              "ARTIFACT_INVALID",
              `${source.path} is a source workspace, not a packed artifact. Install ` +
                `{ mode: "source", path: "${source.path}" } and the daemon will build, pack, ` +
                `and install it in one step.`,
            );
          }
          // No pack sentinel but no source structure either: this may be a
          // legacy artifact packed before the sentinel existed (or extracted
          // store bundle bytes). The caller explicitly declared `bundle`, so
          // fall back to deep artifact validation — a manifest-valid dir
          // installs as-is; anything else gets both corrective paths.
          const appId = await this.readManifestAppId(source.path);
          try {
            await validateInstalledArtifact(source.path, appId);
          } catch (err) {
            throw new AppManagerError(
              "ARTIFACT_INVALID",
              `${source.path} is not a recognizably packed artifact (no pack sentinel, which ` +
                `every packed artifact carries) and failed artifact validation: ` +
                `${err instanceof Error ? err.message : String(err)}. If this is the app's ` +
                `source workspace, install { mode: "source", path: "${source.path}" }; if it ` +
                `is meant to be a packed artifact, rebuild it with a source-mode install of ` +
                `the app's repo.`,
            );
          }
          return appId;
        }
        case "bundle": {
          const appId = await this.readManifestAppId(source.path);
          try {
            await validateInstalledArtifact(source.path, appId);
          } catch (err) {
            throw new AppManagerError(
              "ARTIFACT_INVALID",
              err instanceof Error ? err.message : String(err),
            );
          }
          return appId;
        }
      }
    }

    switch (kind) {
      case "missing":
        throw new AppManagerError(
          "ARTIFACT_INVALID",
          `Source path ${source.path} does not exist. Check the path, or scaffold a new app ` +
            `there first with { op: "create", appId: "<app-id>", rootPath: "${source.path}" }.`,
        );
      case "no-manifest":
        throw new AppManagerError(
          "ARTIFACT_INVALID",
          `${source.path} has no app.yaml, so it is not an app workspace. If this is a fresh ` +
            `directory, scaffold it first with { op: "create", appId: "<app-id>", rootPath: ` +
            `"${source.path}" }; otherwise fix source.path to the app's repo root.`,
        );
      case "bundle":
        throw new AppManagerError(
          "ARTIFACT_INVALID",
          `${source.path} is a packed artifact, not a source workspace. Install it as-is with ` +
            `{ mode: "bundle", path: "${source.path}" }` +
            (appRepo != null
              ? `, or rebuild from source with { mode: "source", path: "${appRepo}" }.`
              : `, or pass the app's repo root as source.path to rebuild from source.`),
        );
      case "source":
        return await this.readManifestAppId(source.path);
    }
  }

  /** Read the app id from `<dir>/app.yaml`; any read/shape failure is a gate-class rejection. */
  private async readManifestAppId(dir: string): Promise<AppId> {
    const manifestPath = join(dir, "app.yaml");
    try {
      return (await readManifestIdAndVersion(manifestPath)).id;
    } catch (err) {
      throw new AppManagerError(
        "ARTIFACT_INVALID",
        `Could not read ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async uninstall(appId: AppId, opts: UninstallOpts = {}): Promise<UninstallResult> {
    this.assertSafeAppId(appId);
    if (appId === SYSTEM_APP_ID) {
      throw new AppManagerError("SYSTEM_PROTECTED", `app "${appId}" cannot be uninstalled`);
    }
    return this.perAppMutex.runExclusive(appId, async () => {
      // First-party gate runs before any state transition (no in-flight op,
      // no lockfile write): the rejection must leave the app exactly as it
      // was. Every uninstall entry point (HTTP route, app_management action,
      // CLI) funnels through this method, so this is the single validator.
      const existing = (await this.readLockfileForMutation()).apps[appId];
      if (existing == null) {
        return { alreadyAbsent: true, purged: false, diskCleanupError: null };
      }
      if (existing.firstParty && !opts.firstParty) {
        throw new AppManagerError(
          "FIRST_PARTY_PROTECTED",
          `app "${appId}" is part of the Rome distribution and cannot be uninstalled. ` +
            `Disable it instead (set enabled: false).`,
        );
      }
      const startedAt = nowIso();
      this.inFlightOps.set(appId, { kind: "uninstall", startedAt });
      try {
        await this.catalog?.refresh(appId);
        const lockfile = await this.readLockfileForMutation();
        if (lockfile.apps[appId] == null) {
          return { alreadyAbsent: true, purged: false, diskCleanupError: null };
        }
        // Drop the lockfile entry BEFORE tearDown. A mid-teardown crash (e.g.
        // `tsx watch` restarting the dev daemon when its rm -rf unlinks an
        // imported action/agent file) would otherwise leave a stranded
        // "installed" entry pointing at a half-deleted bundle. Boot's
        // orphan-sweep then cleans up `installed/<appId>/` for any appId not
        // in the lockfile, so a partial teardown is self-healing.
        await this.lockfileMutex.runExclusive(async () => {
          const fresh = await this.readLockfileForMutation();
          delete fresh.apps[appId];
          await writeLockfile(this.lockfilePath, fresh);
        });
        let diskCleanupError: string | null = null;
        try {
          await this.installer.tearDown(appId);
        } catch (err) {
          diskCleanupError = (err as Error).message;
          log.warn("teardown error during uninstall — bundle dir will be GC'd at next boot", {
            appId,
            error: diskCleanupError,
          });
        }
        return { alreadyAbsent: false, purged: !!opts.purge, diskCleanupError };
      } finally {
        this.inFlightOps.delete(appId);
        await this.catalog?.refresh(appId);
      }
    });
  }

  async setEnabled(appId: AppId, enabled: boolean): Promise<void> {
    this.assertSafeAppId(appId);
    if (appId === SYSTEM_APP_ID && !enabled) {
      throw new AppManagerError("SYSTEM_PROTECTED", `app "${appId}" cannot be disabled`);
    }
    await this.perAppMutex.runExclusive(appId, async () => {
      try {
        await this.lockfileMutex.runExclusive(async () => {
          const lockfile = await this.readLockfileForMutation();
          const entry = lockfile.apps[appId];
          if (entry == null) {
            throw new AppManagerError("NOT_INSTALLED", `app "${appId}" is not installed`);
          }
          if (entry.enabled === enabled) return;
          entry.enabled = enabled;
          entry.updatedAt = nowIso();
          await writeLockfile(this.lockfilePath, lockfile);
        });
      } finally {
        await this.catalog?.refresh(appId);
      }
    });
  }

  async boot(): Promise<BootResult> {
    await this.discardNonCurrentLockfile();
    await this.runLegacyMigrationIfNeeded();
    const { lockfile, brokenEntries } = await readLockfileWithEntryIsolation(this.lockfilePath);
    if (brokenEntries.length > 0) {
      log.warn("salvaged broken lockfile entries on boot", { count: brokenEntries.length });
      await writeLockfile(this.lockfilePath, lockfile);
    } else if (!lockfileExists(this.lockfilePath)) {
      // Create an empty lockfile on first boot so subsequent reads are stable.
      await writeLockfile(this.lockfilePath, emptyLockfile());
    }

    const brokenApps: AppId[] = [];
    const sweptStaging: string[] = [];

    // Deliberately do not sweep `installed/<dirname>/` dirs that have no
    // lockfile entry. The blast radius is too wide: an empty / freshly
    // discarded lockfile would wipe every cached bundle on disk, and
    // `discardNonCurrentLockfile` above leaves the lockfile empty by design.
    // Crashed-uninstall recovery now relies on a re-install of the same
    // appId producing the same content hash (cache hit on the dangling
    // dir), with the cost being some disk waste until that happens.

    for (const appId of Object.keys(lockfile.apps)) {
      const swept = await this.installer.sweepStaging(appId).catch(() => [] as string[]);
      sweptStaging.push(...swept);
    }

    for (const [appId, entry] of Object.entries(lockfile.apps)) {
      if (entry.state !== "installed") continue;
      if (entry.installedHash == null) {
        await this.markBroken(appId, "MISSING_HASH", "entry says installed but no installedHash");
        brokenApps.push(appId);
        continue;
      }
      const probe = await this.installer.probe(appId, entry.installedHash);
      if (probe.ok) continue;
      if (appId === SYSTEM_APP_ID) {
        throw new Error(`system app "${appId}" failed probe at boot: ${probe.reason}`);
      }
      await this.markBroken(appId, "PROBE_FAILED", probe.reason);
      brokenApps.push(appId);
    }

    if (this.catalog) {
      const { lockfile: refreshed } = await readLockfileWithEntryIsolation(this.lockfilePath);
      for (const appId of Object.keys(refreshed.apps)) {
        await this.catalog.refresh(appId);
      }
    }

    return {
      appCount: Object.keys(lockfile.apps).length,
      sweptStaging,
      brokenApps,
    };
  }

  /**
   * Discard any `apps.lock.json` whose `schemaVersion` isn't current. The
   * lockfile was deprecated for a stretch (apps lived in per-app
   * `deployment.yaml` files instead) and is now back at v3 with a fundamentally
   * different shape; old v1/v2 files left over from before the deprecation
   * are stale and not worth migrating. Rename aside so subsequent reads see
   * no lockfile — `runLegacyMigrationIfNeeded` then handles deployment.yaml
   * profiles, and the daemon's boot step 5c re-installs any core-required
   * app missing from the lockfile. Stale bundles under
   * `apps/installed/` are left in place; a re-install of the same appId is
   * a content-addressed cache hit on the dangling dir.
   *
   * Only triggers when `schemaVersion` is present and not current. Malformed
   * JSON / missing `schemaVersion` / wrong root shape still fall through to
   * the loud `LockfileTopLevelError` so genuine corruption isn't masked.
   */
  private async discardNonCurrentLockfile(): Promise<void> {
    if (!lockfileExists(this.lockfilePath)) return;
    let raw: string;
    try {
      raw = await readFile(this.lockfilePath, "utf-8");
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const observedVersion = (parsed as Record<string, unknown>).schemaVersion;
    if (observedVersion === APPS_LOCKFILE_SCHEMA_VERSION) return;
    if (typeof observedVersion !== "number") return;

    const backupPath = `${this.lockfilePath}.bak-${Date.now()}-${process.pid}`;
    await rename(this.lockfilePath, backupPath);
    log.warn("discarded stale apps.lock.json (non-current schemaVersion)", {
      observedVersion,
      expectedVersion: APPS_LOCKFILE_SCHEMA_VERSION,
      backupPath,
      note: "core-required apps will be re-seeded; other apps must be re-installed",
    });
  }

  /**
   * Detect a pre-imperative profile (legacy `apps/<appId>/deployment.yaml`
   * + version-keyed bundle dirs, no `apps.lock.json` yet) and run the one-shot
   * migration. Idempotent — `migrateToLockfile` bails when lockfile or
   * `installed/` already exists.
   */
  private async runLegacyMigrationIfNeeded(): Promise<void> {
    if (lockfileExists(this.lockfilePath)) return;
    const profileRoot = dirname(this.lockfilePath);
    const legacyAppsDir = join(profileRoot, "apps");
    if (!existsSync(legacyAppsDir)) return;
    const result = await migrateToLockfile({ profileRoot });
    if (result.skipped) {
      log.info("legacy migration skipped", { reason: result.reason });
    } else {
      log.info("legacy migration done", {
        migrated: result.migrated,
        failures: result.failures.length,
      });
    }
  }

  async markBroken(appId: AppId, code: string, message: string): Promise<void> {
    await this.lockfileMutex.runExclusive(async () => {
      const lockfile = await this.readLockfileForMutation();
      const entry = lockfile.apps[appId];
      if (entry == null) return;
      lockfile.apps[appId] = {
        ...entry,
        state: "broken",
        lastError: { code, message },
        updatedAt: nowIso(),
      };
      await writeLockfile(this.lockfilePath, lockfile);
    });
  }

  private assertSafeAppId(appId: AppId): void {
    if (!isValidAppId(appId)) {
      throw new AppManagerError("INVALID_APP_ID", `Invalid appId "${appId}"`);
    }
  }

  private async readLockfileForMutation(): Promise<AppLockfile> {
    try {
      const { lockfile } = await readLockfileWithEntryIsolation(this.lockfilePath);
      return lockfile;
    } catch (err) {
      if (err instanceof LockfileTopLevelError) throw err;
      throw err;
    }
  }
}

function toLastError(err: unknown): { code: string; message: string } {
  if (err instanceof AppManagerError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: "INSTALLER_ERROR", message: err.message };
  }
  return { code: "INSTALLER_ERROR", message: String(err) };
}

export { APPS_LOCKFILE_SCHEMA_VERSION };
