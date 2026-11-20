/**
 * app_management — Drive the Rome app lifecycle (create / install / uninstall /
 * enable / disable) from an agent turn.
 *
 * `install` is the single install/upgrade primitive. `source.mode` declares
 * what the target is, and the daemon cross-checks it against the directory's
 * actual shape: `source` = the app's repo root (the daemon builds, packs
 * into `<repo>/.rome/artifact`, and installs — the one-step dev path),
 * `bundle` = an already-packed artifact installed as-is, `appstore` = fetch
 * from the Rome App Store. For Store installs, omit `version` to install the
 * latest live version, or pass a specific live historical version from
 * `system:app_store_search` listing detail. The daemon installs runtime deps before
 * activating the bundle in every mode. Install is an awaited completion
 * barrier: it returns only after the built bundle is active and the runtime
 * catalog has reloaded it, so callers do not need to poll deployment state.
 *
 * `uninstall` deletes the bundle and (optionally) purges DB tables + data;
 * `set_enabled` toggles the enabled flag without re-installing.
 *
 * First-party apps (shipped with Rome) are bundled at build time and
 * installed at boot. `uninstall` rejects them with FIRST_PARTY_PROTECTED;
 * `set_enabled` is the only lifecycle control that applies to them.
 *
 * @example
 *   await callAction("system:app_management", {
 *     op: "create",
 *     appId: "notes",
 *     rootPath: "/absolute/path/to/dev/working/tree",
 *     template: "default",
 *   });
 *   // Edit the scaffold, then a single install builds + packs + installs.
 *   // No appId — the daemon derives it from the source and returns it:
 *   await callAction("system:app_management", {
 *     op: "install",
 *     source: {
 *       mode: "source",
 *       path: "/absolute/path/to/dev/working/tree",
 *     },
 *   });
 */

export type AppInstallSource =
  /**
   * `path` is the app's source workspace (repo root). The daemon runs the
   * workspace's own build, packs, and installs in one step.
   */
  | { mode: "source"; path: string }
  /** `path` must point at a packed app artifact directory, not a source workspace. */
  | { mode: "bundle"; path: string }
  | {
      mode: "appstore";
      /**
       * Logical Rome Cloud listing id — `xiaohongshu` (unscoped) or
       * `@handle/slug` (scoped). The daemon derives the bundle URL itself
       * from its configured registry origin; callers must not pass a full
       * URL. (Legacy lockfile entries that still hold a URL form are
       * tolerated on re-install and normalised on disk.)
       */
      listingId: string;
      /**
       * Optional for agent calls. When omitted, app_management resolves the
       * listing detail and installs the latest live version. Pass a specific
       * version to install a historical version; it must still be live in the
       * Store listing detail.
       */
      version?: string;
      /**
       * Optional. When omitted, app_management resolves the authoritative
       * digest from the Store listing detail before calling the lifecycle
       * installer, then the daemon pins it into the lockfile (both
       * `installedHash` and the entry's `source.contentHash`).
       *
       * Security tradeoff: omitting `contentHash` means the daemon fetches
       * both the hash and the bundle from the same registry, so a
       * network-level attacker on the daemon's outbound path can serve a
       * matched malicious pair without independent verification. Callers
       * that already hold the digest from an independent path (e.g. the
       * dashboard, which gets it for free in the listing-detail payload)
       * should always pass it as a second trust anchor against what the
       * registry serves at install time. Omitting is intended for
       * agent-driven installs that have no separate channel.
       */
      contentHash?: string;
    };

export interface AppManagementTemplateCreateInput {
  op: "create";
  appId: string;
  from?: never;
  name?: never;
  /**
   * Absolute filesystem path where the bundled template will be materialized.
   * Required — `op: "create"` is a path-primitive: the caller decides where
   * scaffolding lands. The daemon never picks a default location.
   */
  rootPath: string;
  /**
   * Which bundled template to scaffold. `default` is a generic
   * hello-world app; `workflow` scaffolds a workflow app — an action that runs
   * a DAG of other actions with a live diagram + run UI. See `workflow_creation`.
   */
  template: "default" | "workflow";
}

export interface AppManagementRemixCreateInput {
  op: "create";
  /** Filesystem-safe scoped id (`ray-calendar` for `@ray/calendar`). */
  appId: string;
  /** User-facing scoped remix name, for example `@ray/calendar`. */
  name: string;
  from: Extract<import("@rome-os/app-runtime").AppLifecycleCreateParams, { name: string }>["from"];
}

export type AppManagementCreateInput =
  | AppManagementTemplateCreateInput
  | AppManagementRemixCreateInput;

export interface AppManagementInstallInput {
  op: "install";
  /**
   * Required on every install call. The daemon does not infer `source` from
   * the lockfile, so a re-install after edits must pass the same source shape
   * as the first install. For the dev loop that is `{ mode: "source", path:
   * "<repo root>" }` every time — the daemon rebuilds and re-packs on each
   * install.
   */
  source: AppInstallSource;
  enabled?: boolean;
}

export interface AppManagementUninstallInput {
  op: "uninstall";
  appId: string;
  purge?: boolean;
}

export interface AppManagementSetEnabledInput {
  op: "set_enabled";
  appId: string;
  enabled: boolean;
}

export type AppManagementInput =
  | AppManagementCreateInput
  | AppManagementInstallInput
  | AppManagementUninstallInput
  | AppManagementSetEnabledInput;

export interface InstallResult {
  /** Derived by the daemon from the source — manifest id for local sources, listing slug for appstore. */
  appId: string;
  state: "installed" | "failed";
  installedHash: string | null;
  installedVersion: string | null;
  error: { code: string; message: string } | null;
}

export interface UninstallResult {
  alreadyAbsent: boolean;
  purged: boolean;
  diskCleanupError: string | null;
}

export interface SetEnabledResult {
  appId: string;
  enabled: boolean;
}

export interface CreateResult {
  appId: string;
  created: true;
  rootPath: string;
}

export type AppManagementOutput = InstallResult | UninstallResult | SetEnabledResult | CreateResult;
