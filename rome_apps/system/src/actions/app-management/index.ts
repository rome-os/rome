import { createAppLogger } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
  AppLifecycle,
} from "@rome-os/app-runtime";
import type { AppStoreReader } from "../app-store-common.js";
import { chooseLiveVersion, storeResultError } from "../app-store-common.js";
import type {
  AppManagementInput,
  AppManagementOutput,
  AppInstallSource,
  CreateResult,
  InstallResult,
  UninstallResult,
  SetEnabledResult,
} from "./types.js";

const log = createAppLogger("app_management");

export interface AppManagementDeps {
  /** The app lifecycle authority: the real `AppLifecycleService` in the main
   * process, an `AppManagerProxy` (RPC to main) in a worker. Always the proxy
   * in practice — the worker holds no writer — but injected per process so the
   * action stays process-agnostic. */
  appManager: AppLifecycle;
  /** Rome App Store read side: real service in main, RPC proxy in workers. */
  appStore: AppStoreReader;
}

export type {
  AppManagementInput,
  AppManagementOutput,
  AppManagementInstallInput,
  AppManagementCreateInput,
  AppManagementUninstallInput,
  AppManagementSetEnabledInput,
  CreateResult,
  InstallResult,
  UninstallResult,
  SetEnabledResult,
  AppInstallSource,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInstallFailure(install: unknown, label: string): string | null {
  if (!isRecord(install)) return null;
  const failed = install.state === "failed" || install.error != null;
  if (!failed) return null;

  const appId =
    typeof install.appId === "string" && install.appId ? ` as app ${install.appId}` : "";
  let reason = "unknown error";
  if (typeof install.error === "string" && install.error) {
    reason = install.error;
  } else if (isRecord(install.error) && typeof install.error.message === "string") {
    reason = install.error.message;
  }
  return `Failed to install ${label}${appId}: ${reason}`;
}

async function resolveInstallSource(
  input: AppManagementInput,
  deps: AppManagementDeps,
): Promise<{ source: AppInstallSource } | { error: string }> {
  if (input.op !== "install") return { error: "source can only be resolved for install." };
  const source = input.source;
  if (source.mode !== "appstore") return { source };

  const detail = await deps.appStore.getListing({
    listingId: source.listingId,
    includeInstalledState: true,
  });
  const error = storeResultError(detail);
  if (error) return { error };
  if (!detail.body.available) {
    return {
      error:
        detail.body.reason ??
        "Rome App Store is not available for this instance, so the install target cannot be resolved.",
    };
  }

  const target = chooseLiveVersion(detail.body, source.version);
  if (!target) {
    return {
      error: source.version
        ? `Version ${source.version} is not a live version for listing ${source.listingId}.`
        : `Listing ${source.listingId} has no live version to install.`,
    };
  }
  return {
    source: {
      ...source,
      version: target.version,
      contentHash: (source.contentHash ?? target.contentHash).toLowerCase(),
    },
  };
}

export async function appManagement(
  input: AppManagementInput,
  deps: AppManagementDeps,
): Promise<ActionResult<AppManagementOutput>> {
  switch (input.op) {
    case "create":
      log.info("app create requested", {
        appId: input.appId,
        ...(input.from ? { from: input.from } : { template: input.template }),
      });
      return {
        status: "ok",
        data: (await deps.appManager.create(
          input.from
            ? { appId: input.appId, name: input.name, from: input.from }
            : { appId: input.appId, rootPath: input.rootPath, template: input.template },
        )) as CreateResult,
      };
    case "install": {
      const resolved = await resolveInstallSource(input, deps);
      if ("error" in resolved) return { status: "error", error: resolved.error };
      const result = (await deps.appManager.install({
        source: resolved.source,
        enabled: input.enabled,
      })) as InstallResult;
      const label =
        input.source.mode === "appstore" ? `Store listing ${input.source.listingId}` : "app";
      const installError = readInstallFailure(result, label);
      if (installError) {
        log.warn("app install failed", { source: input.source, enabled: input.enabled, result });
        return { status: "error", error: installError };
      }
      return { status: "ok", data: result };
    }
    case "uninstall":
      return {
        status: "ok",
        data: (await deps.appManager.uninstall({
          appId: input.appId,
          purge: input.purge === true,
        })) as UninstallResult,
      };
    case "set_enabled":
      return {
        status: "ok",
        data: (await deps.appManager.setEnabled({
          appId: input.appId,
          enabled: input.enabled,
        })) as SetEnabledResult,
      };
    default: {
      const exhaustive: never = input;
      throw new Error(`Unknown app_management op: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function createAppManagementAction(config: ActionConfig, deps: AppManagementDeps): Action {
  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["create", "install", "uninstall", "set_enabled"],
          description: [
            "Lifecycle operation. One per call.",
            "First-party apps (shipped with Rome) are bundled at build time and installed automatically at boot — they cannot be installed or uninstalled via this action. The only first-party control here is 'set_enabled'.",
            "- 'create': create a new dev app. For a new app from scratch, pass `rootPath` and `template`. For a remix, pass `from: { appId }` for installed code or `from: { listingId, version, contentHash }` for a Store bundle, plus the new `appId` and scoped `name`. The daemon creates an independent project without installing the source. The two create shapes are mutually exclusive. Build and install the new app only after finishing the requested changes.",
            "- 'install': install (or re-install) an app via AppManager. Takes NO `appId` — the daemon derives it from the source (the manifest id at `source.path` for local modes, the listing slug for appstore) and returns it in the result. For local dev the one-step path is `source.mode = 'source'` with `source.path` = the root of a standalone dev app repo: the daemon runs the workspace's build, packs into `<repo>/.rome/artifact`, and installs — no separate pack step. `mode: 'bundle'` installs an already-packed artifact dir as-is. For Rome App Store installs, use `system:app_store_search` first, then call install with `source.mode = 'appstore'` and `listingId`; omit `version` to install the latest live version, or pass a specific live historical version. The declared mode is cross-checked against the directory's actual shape and a mismatch is rejected up front with ARTIFACT_INVALID (before anything is staged or recorded — a previously installed version keeps running untouched), with the error naming the exact next command. Build/pack/download failures also leave the prior version running and return the error. An install whose derived id collides with a first-party app is rejected with FIRST_PARTY_PROTECTED. Returns once the bundle is active.",
            "- 'uninstall': remove the app via AppManager. Pass `purge: true` to drop the DB tables and data dir. Rejected with FIRST_PARTY_PROTECTED for first-party apps — disable them with 'set_enabled' instead.",
            "- 'set_enabled': flip the app's enabled flag without re-installing. Works for every app except 'system'.",
          ].join("\n"),
        },
        appId: {
          type: "string",
          pattern: "^[a-z][a-z0-9-]*$",
          description:
            "App id. Required for 'create', 'uninstall', and 'set_enabled'; must match " +
            "/^[a-z][a-z0-9-]*$/. Not accepted for 'install' — the daemon derives the id " +
            "from the source and returns it.",
        },
        rootPath: {
          type: "string",
          description:
            "Required for a from-scratch create: absolute filesystem path where the bundled template is materialized. Omit for a remix, which always uses the custom app authoring root. Refuses if the target directory exists and is non-empty.",
        },
        name: {
          type: "string",
          minLength: 1,
          description:
            "Required for a remix create (`from` present): the user-facing scoped name, for example `@ray/calendar`. The local `appId` must be the filesystem-safe scoped form (`ray-calendar`).",
        },
        from: {
          description:
            "For a remix create: copy local installed code with {appId}, or use a pinned Store bundle with {listingId, version, contentHash}. Core reuses an identical installed pin or downloads and extracts the bundle without installing the source. It checks includeSource and never changes the original app.",
          oneOf: [
            {
              type: "object",
              properties: {
                appId: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Canonical installed app id, including the full @handle/slug for scoped apps.",
                },
                expectedSource: {
                  type: "object",
                  description: "Optional Store pin; reject if the installed source changed.",
                  properties: {
                    listingId: { type: "string", minLength: 1 },
                    version: { type: "string", minLength: 1 },
                    contentHash: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
                  },
                  required: ["listingId", "version", "contentHash"],
                  additionalProperties: false,
                },
              },
              required: ["appId"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                listingId: { type: "string", minLength: 1 },
                version: { type: "string", minLength: 1 },
                contentHash: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
              },
              required: ["listingId", "version", "contentHash"],
              additionalProperties: false,
            },
          ],
        },
        template: {
          type: "string",
          enum: ["default", "workflow"],
          description:
            "Required for a from-scratch create and omitted for a remix. There is no default; choose deliberately via this litmus. 'workflow' scaffolds a workflow app: one action whose body is a DAG (pipeline/parallel/branch/map) of inline steps that transform inputs, call existing actions, and `summon` an LLM for any generative step — it takes inputs and returns a result. Choose 'workflow' for almost everything: summaries, digests, drafting/writing, triage, monitor-and-notify, multi-source synthesis, 'do X when Y' — INCLUDING generative work the user reruns and reviews (the platform persists run history for free). 'default' is a generic app you build up by hand; choose it ONLY when the thing genuinely needs a user-edited data model, multiple distinct operations, or a conversational/long-lived agent. A one-shot 'generate X from Y' is a `summon` step in a workflow, NOT a 'default' app with its own writer agent. See the workflow_creation and app_creation skills.",
        },
        source: {
          type: "object",
          description:
            "Install source. Required on every install call — the daemon does not infer it from the lockfile, so a re-install after edits must pass the same source as the first install. `mode` declares what the target is and is cross-checked against the directory's actual shape. Shapes: `{ mode: 'source', path: '<abs app repo root>' }` — the standard dev path; the daemon builds, packs, and installs in one step. `{ mode: 'bundle', path: '<abs packed artifact dir>' }` — install already-packed bytes as-is (CI artifacts, `rome build` output). `{ mode: 'appstore', listingId, version?, contentHash? }` — fetch from the Rome App Store. For appstore: call app_store_search first. `listingId` is the logical Rome Cloud listing id (`xiaohongshu` for unscoped, or `@handle/slug` for scoped). Omit `version` to install the latest live version, or pass a specific historical version if the listing detail still marks it live. `contentHash` is the optional 64-char hex sha256 of the tarball; when omitted, this action resolves it from the Store listing detail before installing.",
          properties: {
            mode: { type: "string", enum: ["source", "bundle", "appstore"] },
            path: { type: "string" },
            listingId: { type: "string" },
            version: { type: "string" },
            contentHash: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
          },
          required: ["mode"],
          allOf: [
            {
              if: { properties: { mode: { const: "source" } }, required: ["mode"] },
              then: { required: ["path"] },
            },
            {
              if: { properties: { mode: { const: "bundle" } }, required: ["mode"] },
              then: { required: ["path"] },
            },
            {
              if: { properties: { mode: { const: "appstore" } }, required: ["mode"] },
              then: { required: ["listingId"] },
            },
          ],
        },
        enabled: {
          type: "boolean",
          description:
            "For install: whether the app should be enabled (defaults true). For set_enabled: the target state (required).",
        },
        purge: {
          type: "boolean",
          description:
            "For uninstall: when true, drop the app's DB tables and data dir. Default false.",
        },
      },
      required: ["op"],
      allOf: [
        {
          if: { properties: { op: { const: "install" } }, required: ["op"] },
          then: { required: ["source"], not: { required: ["appId"] } },
        },
        {
          if: { properties: { op: { const: "create" } }, required: ["op"] },
          then: {
            required: ["appId"],
            oneOf: [
              {
                required: ["rootPath", "template"],
                not: { anyOf: [{ required: ["from"] }, { required: ["name"] }] },
              },
              {
                required: ["from", "name"],
                not: { anyOf: [{ required: ["rootPath"] }, { required: ["template"] }] },
              },
            ],
          },
        },
        {
          if: { properties: { op: { const: "uninstall" } }, required: ["op"] },
          then: { required: ["appId"] },
        },
        {
          if: { properties: { op: { const: "set_enabled" } }, required: ["op"] },
          then: { required: ["appId", "enabled"] },
        },
      ],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<ActionResult> => {
      return await appManagement(input as unknown as AppManagementInput, deps);
    },
  };
}

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<AppManagementDeps>,
): Action {
  return createAppManagementAction(config, deps);
}
