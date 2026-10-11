import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createLogger } from "../logger.js";
import { getProjectRoot } from "../paths.js";
import {
  appIdToPathSegment,
  hashArtifact,
  readManifestSummary,
  readPackageManifest,
  runPnpm,
  sourceRootForArtifactPath,
  validateInstalledArtifact,
  type PackageJsonManifest,
} from "@rome-os/app-runtime/packaging";

const log = createLogger("app-prepare");

/**
 * Source for `prepare()`. Both kinds point at an already-**packed** app
 * artifact directory — `prepare()` itself does not snapshot or validate.
 * Packing (the snapshot + manifest-validation pipeline) is the caller's
 * job, run via `packArtifact`.
 *
 *   - `artifact` → caller-packed dir. Hash is derived from the dir's
 *     contents via `hashArtifact`.
 *   - `sealed`   → publisher-packed dir extracted from an app-store
 *     tarball; the publisher's `contentHash` doubles as the cache key
 *     (already verified against the bundle bytes by the caller).
 */
export type PrepareInput =
  | { kind: "artifact"; appId: string; artifactRoot: string }
  | { kind: "sealed"; appId: string; extractedRoot: string; contentHash: string };

export interface PreparedArtifact {
  appId: string;
  hash: string;
  /** Absolute path to `installed/<appId>/<hash>/`. */
  root: string;
  /** Manifest version pulled from the installed `app.yaml`. */
  version: string;
}

/**
 * The artifact's manifest declares a different app id than the one the caller
 * is installing under. Typed so AppManager can treat it as a gate-class
 * rejection (nothing recorded) rather than an operational install failure —
 * for appstore installs this means the registry listing and the published
 * bundle disagree about the app's identity.
 */
export class ManifestIdMismatchError extends Error {
  constructor(
    readonly expectedId: string,
    readonly actualId: string,
    readonly manifestPath: string,
  ) {
    super(
      `Source manifest id "${actualId}" at ${manifestPath} does not match prepare target "${expectedId}"`,
    );
    this.name = "ManifestIdMismatchError";
  }
}

export interface PrepareOptions {
  installedRoot: string;
}

/**
 * Take a **packed** app artifact to a content-addressed installed bundle.
 * Packing — snapshot, `appRoot` selection, manifest validation — is the
 * caller's job, run via `packArtifact`. `prepare()` consumes the result
 * of that step; it does not snapshot or filter.
 *
 * Per-kind behavior diverges only at cache-key derivation:
 *
 *   - `artifact` → `hash = hashArtifact(artifactRoot)`.
 *   - `sealed`   → `hash = contentHash` (caller has already verified it
 *     against the bundle bytes).
 *
 * Both kinds share the post-hash pipeline:
 *   1. If `installed/<appId>/<hash>/` exists, return it (cache hit).
 *   2. Recursively copy the input artifact into a temp staging dir.
 *   3. `pnpm install --prod` if `package.json` declares runtime deps. Release-age
 *      quarantine is disabled for every artifact so apps can consume Rome SDKs
 *      published alongside an image. Legacy artifacts without a bundled
 *      `pnpm-workspace.yaml` also pass
 *      `--ignore-workspace --config.strict-dep-builds=false`.
 *   4. Re-validate the staged artifact against its manifest as a defence
 *      against a corrupted packed input. Loud failure here, before commit.
 *   5. Atomic rename the staging dir to `installed/<appId>/<hash>/`.
 *
 * Concurrency: must run under the `AppLifecycleManager` mutex. The cache-hit
 * `existsSync` → return path is only race-free because no concurrent prepare
 * or `gcInstalledCache` can mutate `installed/<appId>/<hash>/` while we hold
 * the lock. Calling `prepare()` outside the mutex is unsafe.
 */
export async function prepare(
  input: PrepareInput,
  options: PrepareOptions,
): Promise<PreparedArtifact> {
  const sourceRoot = input.kind === "artifact" ? input.artifactRoot : input.extractedRoot;
  const manifestPath = join(sourceRoot, "app.yaml");
  if (!existsSync(manifestPath)) {
    const appRepo = sourceRootForArtifactPath(sourceRoot);
    throw new Error(
      input.kind === "artifact"
        ? `${sourceRoot} is not a packed app artifact (no app.yaml). ` +
            (appRepo != null
              ? `Install { mode: "source", path: "${appRepo}" } to build + install in one step.`
              : `Install { mode: "source", path: "<app repo>" } — the daemon builds, packs, ` +
                `and installs in one step.`)
        : `Prepare source ${sourceRoot} is missing app.yaml`,
    );
  }

  const sourceManifest = await readManifestSummary(manifestPath);
  if (sourceManifest.id !== input.appId) {
    throw new ManifestIdMismatchError(input.appId, sourceManifest.id, manifestPath);
  }

  const hash = input.kind === "sealed" ? input.contentHash : await hashArtifact(input.artifactRoot);
  const appInstalledRoot = join(options.installedRoot, appIdToPathSegment(input.appId));
  const finalRoot = join(appInstalledRoot, hash);

  if (existsSync(join(finalRoot, "app.yaml"))) {
    log.debug("prepare cache hit", { appId: input.appId, hash, finalRoot });
    return { appId: input.appId, hash, root: finalRoot, version: sourceManifest.version };
  }

  await mkdir(appInstalledRoot, { recursive: true });
  const stagingRoot = await mkdtemp(join(appInstalledRoot, `.staging-${hash}-`));

  try {
    await copyArtifactIntoStaging(sourceRoot, stagingRoot);
    await installProductionDeps(stagingRoot);
    await validateInstalledArtifact(stagingRoot, input.appId);
    await rm(finalRoot, { recursive: true, force: true });
    await rename(stagingRoot, finalRoot);
  } catch (err) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  log.info("prepared app artifact", {
    appId: input.appId,
    hash,
    root: finalRoot,
    version: sourceManifest.version,
    kind: input.kind,
  });

  return { appId: input.appId, hash, root: finalRoot, version: sourceManifest.version };
}

/**
 * Recursively copy a packed artifact into the staging dir. `node_modules`
 * is intentionally skipped — the caller's pack may have shipped one, but
 * `installProductionDeps` regenerates it against the install host so
 * native deps land for the right Node ABI.
 */
async function copyArtifactIntoStaging(artifactRoot: string, stagingRoot: string): Promise<void> {
  await mkdir(stagingRoot, { recursive: true });
  await cp(artifactRoot, stagingRoot, {
    recursive: true,
    dereference: true,
    filter: (sourcePath: string) => {
      const rel = relative(artifactRoot, sourcePath);
      if (rel === "") return true;
      const segments = rel.split(sep);
      if (segments.includes("node_modules")) return false;
      if (segments.includes(".git")) return false;
      if (segments.includes(".rome_store")) return false;
      return true;
    },
  });
}

async function installProductionDeps(stagingRoot: string): Promise<void> {
  const pkgPath = join(stagingRoot, "package.json");
  if (!existsSync(pkgPath)) return;
  const pkg = await readPackageManifest(stagingRoot);
  const depCount = Object.keys(pkg.dependencies ?? {}).length;
  if (depCount === 0) return;
  log.info("installing app production deps", {
    cwd: stagingRoot,
    depCount,
  });
  // `--no-frozen-lockfile`: apps may not ship per-app lockfiles, so the
  // install host is allowed to solve prod deps once for this content hash.
  //
  // Do not pass `--ignore-workspace` when the artifact carries its own
  // pnpm-workspace.yaml: pnpm 11 stores `allowBuilds` approvals there, and
  // approved runtime postinstalls must still run during materialization.
  const installArgs = buildProductionInstallArgs(stagingRoot);
  await runPnpm(installArgs, {
    cwd: stagingRoot,
  });
  await linkWorkspaceRuntimeDependency(stagingRoot, pkg);
}

export function buildProductionInstallArgs(stagingRoot: string): string[] {
  // First-party apps and their Rome SDK dependencies may be published in the
  // same release window. Make that release-day install contract explicit at the
  // installer boundary instead of relying on every artifact to carry a matching
  // pnpm-workspace.yaml setting.
  const installArgs = [
    "install",
    "--prod",
    "--no-frozen-lockfile",
    "--config.minimum-release-age=0",
  ];
  if (!existsSync(join(stagingRoot, "pnpm-workspace.yaml"))) {
    // Legacy/pre-approval artifacts do not have a place to declare pnpm 11
    // build-script decisions. Keep materialization permissive for that
    // fallback path while preserving strict approvals for modern artifacts.
    installArgs.push("--ignore-workspace", "--config.strict-dep-builds=false");
  }
  return installArgs;
}

async function linkWorkspaceRuntimeDependency(
  stagingRoot: string,
  pkg: PackageJsonManifest,
): Promise<void> {
  if (!pkg.dependencies?.["@rome-os/app-runtime"]) return;

  const runtimeRoot = join(getProjectRoot(), "packages", "app-runtime-sdk");
  if (!existsSync(join(runtimeRoot, "package.json"))) return;

  const scopeDir = join(stagingRoot, "node_modules", "@rome-os");
  const linkPath = join(scopeDir, "app-runtime");
  await mkdir(scopeDir, { recursive: true });
  await rm(linkPath, { recursive: true, force: true });
  await symlink(runtimeRoot, linkPath, "dir");
}

/**
 * Best-effort sweep of stale `installed/<appId>/<hash>/` dirs after a
 * successful prepare, keeping the most recently modified `keep` entries plus
 * any explicitly listed in `protectedHashes`. The caller passes the active
 * hash via `protectedHashes` because cache-hit prepares don't touch mtime,
 * so an active-but-old cached entry would otherwise be eligible for sweep.
 * Failure is logged and swallowed — GC is best-effort.
 */
export async function gcInstalledCache(
  installedRoot: string,
  appId: string,
  keep: number,
  protectedHashes: readonly string[] = [],
): Promise<void> {
  const appDir = join(installedRoot, appIdToPathSegment(appId));
  if (!existsSync(appDir)) return;
  try {
    const entries = await readdir(appDir, { withFileTypes: true });
    const hashDirs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map(async (entry) => {
          const stats = await stat(join(appDir, entry.name));
          return { name: entry.name, mtimeMs: stats.mtimeMs };
        }),
    );
    hashDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const protectedSet = new Set(protectedHashes);
    const deletable = hashDirs.filter((dir) => !protectedSet.has(dir.name));
    await Promise.all(
      deletable
        .slice(keep)
        .map((stale) => rm(join(appDir, stale.name), { recursive: true, force: true })),
    );
  } catch (err) {
    log.warn("failed to gc installed cache", {
      appId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
