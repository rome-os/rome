/**
 * Boot install of first-party apps. Every packed artifact in
 * `dist/first-party-artifacts/` (produced by `pnpm build:apps` at build time)
 * is installed at boot — first-party apps ship with Rome, are not user
 * installable or uninstallable, and only their `enabled` flag is user
 * controlled.
 *
 * Boot re-applies an artifact whenever its content hash differs from the
 * installed bundle's `installedHash`. Any change to app source, deps, or
 * version that goes through `pnpm build:apps` flips the artifact hash and the
 * next boot picks it up. Same artifact in, same hash out, no reinstall — boot
 * stays idempotent.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLogger } from "../logger.js";
import { getFirstPartyArtifactDir } from "../paths.js";
import { hashArtifact, readManifestIdAndVersion } from "./packaging/index.js";
import type { AppCatalog } from "./catalog.js";
import type { AppManager } from "./manager.js";

const log = createLogger("apps-boot");

export interface ShouldReinstallFirstPartyAppArgs {
  /** `installedHash` recorded in the lockfile entry. */
  installedHash: string | null;
  /** Pre-packed first-party artifact dir (`dist/first-party-artifacts/<appId>`). */
  artifactDir: string;
}

/**
 * Decide whether boot should re-install an already-installed first-party app
 * from its packed artifact. Returns true when the artifact's content hash
 * differs from the lockfile's `installedHash`. A null `installedHash`, or an
 * unreadable artifact dir, yields false — the install-if-missing path in the
 * boot loop still handles the former, and the latter is surfaced by the
 * subsequent `app.yaml` existence check.
 */
export async function shouldReinstallFirstPartyAppAtBoot(
  args: ShouldReinstallFirstPartyAppArgs,
): Promise<{ reinstall: boolean; artifactHash: string | null }> {
  if (!args.installedHash) return { reinstall: false, artifactHash: null };
  let artifactHash: string;
  try {
    artifactHash = await hashArtifact(args.artifactDir);
  } catch {
    return { reinstall: false, artifactHash: null };
  }
  return { reinstall: artifactHash !== args.installedHash, artifactHash };
}

/**
 * Enumerate the app ids with a packed first-party artifact under
 * `<projectRoot>/dist/first-party-artifacts/` (a directory containing
 * `app.yaml`). This is the authoritative first-party set: boot installs every
 * one of them.
 */
export async function listPackedFirstPartyAppIds(projectRoot: string): Promise<string[]> {
  const artifactsRoot = join(projectRoot, "dist", "first-party-artifacts");
  if (!existsSync(artifactsRoot)) return [];
  const entries = await readdir(artifactsRoot, { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(artifactsRoot, entry.name, "app.yaml")),
    )
    .map((entry) => entry.name)
    .sort();
}

export interface InstallFirstPartyAppsAtBootOptions {
  appManager: Pick<AppManager, "install" | "uninstall">;
  appCatalog: AppCatalog;
  projectRoot: string;
  /** Wait before the single retry of a failed install. Defaults to 2s. */
  retryDelayMs?: number;
}

const DEFAULT_RETRY_DELAY_MS = 2_000;

export interface FirstPartyBootFailure {
  appId: string;
  /** Message of the last attempt, including the tail of pnpm's output when pnpm failed. */
  error: string;
  /** Hash of the last successful install still on disk (not loaded while the app is `failed`), or null when never installed. */
  priorHash: string | null;
}

export interface FirstPartyBootResult {
  /** Every packed first-party app id (the full set boot converged). */
  firstPartyAppIds: readonly string[];
  installed: readonly string[];
  reinstalled: readonly string[];
  skipped: readonly string[];
  /**
   * First-party apps whose install failed twice. Boot continues without them,
   * and the lockfile records them as `failed`.
   */
  failed: readonly FirstPartyBootFailure[];
  /** First-party apps removed because their packed artifact no longer exists. */
  removed: readonly string[];
}

/**
 * Install / refresh every packed first-party app. Boot never packs — the
 * artifacts are a build output (`pnpm build:apps`). Per app:
 *
 *   - No `installedHash` in the lockfile → install from the artifact.
 *   - `installedHash` differs from the artifact's content hash → reinstall
 *     (the "update" path; see `shouldReinstallFirstPartyAppAtBoot`).
 *   - Entry not yet flagged `firstParty` → reinstall once so the flag is
 *     recorded durably (converges lockfiles written before the flag existed).
 *   - Otherwise → no-op.
 *
 * A failed install is retried once after `retryDelayMs`, which absorbs a
 * transient registry or network fault. A second failure does not fail boot:
 * Rome comes up without that app, the failure lands in the result's `failed`
 * list, and the next boot tries again.
 *
 * Installs omit `enabled` so `AppManager.install()` preserves the prior
 * value — a refresh must not silently re-enable apps the user has disabled.
 * Every install passes `firstParty: true`, which is what the uninstall gate
 * keys off.
 *
 * Installed first-party apps whose packed artifact no longer exists are
 * uninstalled (without purge — app data survives in case the app returns).
 * Users cannot remove first-party apps themselves, so boot owning removal is
 * what keeps an app dropped from the distribution from lingering forever.
 *
 * Throws when no packed artifacts exist at all, or when an artifact's
 * manifest id disagrees with its directory name — both mean the build output
 * is missing or inconsistent, and starting without first-party apps would
 * strand every agent.
 */
export async function installFirstPartyAppsAtBoot(
  opts: InstallFirstPartyAppsAtBootOptions,
): Promise<FirstPartyBootResult> {
  const { appManager, appCatalog, projectRoot } = opts;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const firstPartyAppIds = await listPackedFirstPartyAppIds(projectRoot);
  if (firstPartyAppIds.length === 0) {
    throw new Error(
      `No packed first-party artifacts found under ${join(projectRoot, "dist", "first-party-artifacts")}. ` +
        `First-party apps are packed as a build step — run \`pnpm build:apps\` ` +
        `(or \`pnpm build\`) before starting Rome.`,
    );
  }

  // Hash checks run in parallel — each `hashArtifact()` is a full dir walk
  // and the OS overlaps the I/O — but the install step stays sequential
  // because `appManager.install()` serializes on the lockfile mutex anyway.
  const plan = await Promise.all(
    firstPartyAppIds.map(async (appId) => {
      const installed = appCatalog.get(appId);
      const artifactPath = getFirstPartyArtifactDir(appId, projectRoot);
      if (!installed?.installedHash) {
        return { appId, artifactPath, action: "install" as const, from: null, to: null };
      }
      const { reinstall, artifactHash } = await shouldReinstallFirstPartyAppAtBoot({
        installedHash: installed.installedHash,
        artifactDir: artifactPath,
      });
      if (!reinstall && installed.firstParty) {
        return { appId, artifactPath, action: "skip" as const, from: null, to: null };
      }
      return {
        appId,
        artifactPath,
        action: "reinstall" as const,
        from: installed.installedHash,
        to: artifactHash,
      };
    }),
  );

  const installed: string[] = [];
  const reinstalled: string[] = [];
  const skipped: string[] = [];
  const failed: FirstPartyBootFailure[] = [];
  for (const entry of plan) {
    if (entry.action === "skip") {
      skipped.push(entry.appId);
      continue;
    }
    if (entry.action === "reinstall") {
      log.info("reinstalling first-party app at boot", {
        appId: entry.appId,
        from: entry.from,
        to: entry.to,
      });
    }
    // The lockfile key is the manifest-derived id, so install() would key the
    // entry under whatever id the artifact declares. Validate the manifest id
    // against the directory name BEFORE installing — a mismatched artifact
    // must fail boot without first installing/overwriting some other app.
    const { id: manifestId } = await readManifestIdAndVersion(join(entry.artifactPath, "app.yaml"));
    if (manifestId !== entry.appId) {
      throw new Error(
        `First-party app artifact at ${entry.artifactPath} declares manifest id ` +
          `"${manifestId}" but its directory implies "${entry.appId}". ` +
          `dist/first-party-artifacts is inconsistent — re-run \`pnpm build:apps\`.`,
      );
    }
    // For first install, AppManager defaults enabled to true; for reinstall,
    // omitting `enabled` preserves the prior lockfile value.
    const install = () =>
      appManager.install({
        source: { mode: "bundle", path: entry.artifactPath },
        firstParty: true,
      });
    let result = await install();
    if (result.state === "failed") {
      log.warn("retrying failed first-party app install at boot", {
        appId: entry.appId,
        error: result.error?.message,
        retryDelayMs,
      });
      await delay(retryDelayMs);
      result = await install();
    }
    if (result.state === "failed") {
      const failure: FirstPartyBootFailure = {
        appId: entry.appId,
        error: result.error?.message ?? "unknown error",
        priorHash: result.installedHash,
      };
      failed.push(failure);
      log.error("first-party app install failed at boot", { ...failure });
      continue;
    }
    (entry.action === "reinstall" ? reinstalled : installed).push(entry.appId);
    log.info(
      entry.action === "reinstall"
        ? "reinstalled first-party app at boot"
        : "installed missing first-party app at boot",
      { appId: entry.appId, artifactPath: entry.artifactPath },
    );
  }

  // Removal pass: an installed app flagged firstParty with no packed artifact
  // was dropped from the distribution. The uninstall gate blocks users from
  // removing first-party apps, so boot must reconcile these or they linger
  // forever. No purge — the app's data outlives the code on purpose.
  const packed = new Set(firstPartyAppIds);
  const removed: string[] = [];
  for (const view of appCatalog.list()) {
    if (!view.firstParty || packed.has(view.appId)) continue;
    log.info("removing first-party app dropped from the distribution", { appId: view.appId });
    await appManager.uninstall(view.appId, { firstParty: true });
    removed.push(view.appId);
  }

  return { firstPartyAppIds, installed, reinstalled, skipped, failed, removed };
}
