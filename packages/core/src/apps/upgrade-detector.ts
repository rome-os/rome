/**
 * Read-only scan of the AppCatalog that surfaces apps whose declared source
 * advertises a newer version than the installed bundle. Powers the dashboard
 * "Upgrade →" pill via `GET /apps/updates`.
 *
 * Source flavors:
 *  - `source` / `bundle` — read `app.yaml` at the source path (both keep the
 *    manifest at their root); compare its `version` to the installed
 *    `view.manifest.version`.
 *  - `appstore` — `RomeCloudListingClient` returns the listing's
 *    `highestVersion`, compared to the installed `view.manifest.version`.
 *
 * Detection is version-based (`semver.gt`). Per-app failures (unreadable
 * manifest, malformed version, network error) skip silently — the endpoint
 * is best-effort.
 */
import { join } from "node:path";
import { gt as semverGt, valid as semverValid } from "semver";
import { createLogger } from "../logger.js";
import type { AppCatalog } from "./catalog.js";
import { readManifestIdAndVersion } from "./packaging/index.js";
import type { RomeCloudListingClient } from "./rome-cloud-listing-client.js";
import type { SpecSource } from "./lockfile.js";
import { isResolvedApp, type ResolvedApp } from "./state.js";

const log = createLogger("apps-upgrade-detector");

export interface UpgradeCandidate {
  appId: string;
  currentVersion: string;
  availableVersion: string;
  /**
   * Source to send back via `POST /apps` to actually perform the upgrade.
   * Local (`source`/`bundle`): same mode + path as installed (the daemon
   * rebuilds/reads the new version from the source's `app.yaml`). Appstore:
   * same listingId with `version` bumped to `availableVersion`, and
   * `contentHash` omitted so the daemon re-resolves the digest from the
   * registry — the old hash pinned in the lockfile is for the previous
   * version's bytes and would mismatch.
   */
  targetSource: SpecSource;
}

export interface UpdateSummary {
  upgradable: UpgradeCandidate[];
}

export interface FindUpgradeCandidatesOptions {
  /** Rome Cloud listing client. When omitted, app-store apps are skipped. */
  romeCloudListings?: RomeCloudListingClient;
}

export async function findUpgradeCandidates(
  catalog: AppCatalog,
  opts: FindUpgradeCandidatesOptions = {},
): Promise<UpdateSummary> {
  const listings = opts.romeCloudListings;

  const probes = catalog.list().map(async (view) => {
    if (!isResolvedApp(view)) return null;
    // First-party apps upgrade at boot and reject user installs, so an
    // advertised candidate would be a control that can never succeed.
    if (view.firstParty) return null;
    if (view.source.mode === "source" || view.source.mode === "bundle") {
      return await probeLocal(view);
    }
    if (view.source.mode === "appstore" && listings) {
      return await probeAppstore(view, listings);
    }
    return null;
  });

  const results = await Promise.all(probes);
  const upgradable = results.filter(
    (candidate): candidate is UpgradeCandidate => candidate !== null,
  );
  return { upgradable };
}

async function probeLocal(view: ResolvedApp): Promise<UpgradeCandidate | null> {
  if (view.source.mode !== "source" && view.source.mode !== "bundle") return null;
  const sourceVersion = await readManifestVersion(view.source.path);
  if (sourceVersion == null) return null;
  if (!isUpgrade(view.manifest.version, sourceVersion)) return null;
  return {
    appId: view.appId,
    currentVersion: view.manifest.version,
    availableVersion: sourceVersion,
    targetSource: { mode: view.source.mode, path: view.source.path },
  };
}

async function probeAppstore(
  view: ResolvedApp,
  listings: RomeCloudListingClient,
): Promise<UpgradeCandidate | null> {
  if (view.source.mode !== "appstore") return null;
  const installedVersion = view.manifest.version;
  let highestVersion: string | null;
  try {
    highestVersion = await listings.getHighestVersion(view.source.listingId);
  } catch (err) {
    log.debug("Rome Cloud listing lookup threw; skipping app", {
      appId: view.appId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!highestVersion) return null;
  if (!isUpgrade(installedVersion, highestVersion)) return null;
  return {
    appId: view.appId,
    currentVersion: installedVersion,
    availableVersion: highestVersion,
    targetSource: {
      mode: "appstore",
      listingId: view.source.listingId,
      version: highestVersion,
    },
  };
}

async function readManifestVersion(workspaceRoot: string): Promise<string | null> {
  try {
    return (await readManifestIdAndVersion(join(workspaceRoot, "app.yaml"))).version;
  } catch {
    return null;
  }
}

function isUpgrade(installed: string, candidate: string): boolean {
  if (!semverValid(installed) || !semverValid(candidate)) return false;
  return semverGt(candidate, installed);
}
