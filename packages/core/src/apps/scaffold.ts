import { isAbsolute } from "node:path";
import { createLogger } from "../logger.js";
import { getAppTemplateDir, type AppTemplateKind } from "../paths.js";
import { assertValidAppId } from "./packaging/index.js";
import { appIdToDisplayName, isDirectoryNonEmpty, materializeTemplate } from "./create.js";

const log = createLogger("app-scaffold");

/**
 * Result returned by `scaffoldDevApp` once a fresh dev app has been
 * materialised on disk. Wire-level shape is mirrored in
 * `rome_apps/system/src/actions/app-management/types.d.ts`.
 */
export interface CreateResult {
  appId: string;
  created: true;
  rootPath: string;
}

export interface ScaffoldDevAppOptions {
  /**
   * Which bundled template to scaffold. `default` is the generic hello-world
   * app; `workflow` is the workflow app shell (a `runWorkflow` definition + run
   * action + trigger UI). Ignored when `templateDir` is set.
   */
  template?: AppTemplateKind;
  /**
   * Override the bundled template directory. Defaults to whatever
   * `getAppTemplateDir(template)` resolves to. Tests inject a synthetic tree.
   */
  templateDir?: string;
}

/**
 * Scaffold a new dev app from the bundled template into the caller-supplied
 * `rootPath`. Filesystem-only — does NOT touch the lockfile, registry, or
 * DB. The caller (typically the agent action `app_management { op: "create" }`)
 * chooses `rootPath` and follows up with
 * `op: "install"` to install via `AppManager.install`.
 *
 * `rootPath` must be absolute. Refuses to overwrite an existing non-empty
 * directory: callers must choose a fresh path or clean up first.
 */
export async function scaffoldDevApp(
  appId: string,
  rootPath: string,
  options: ScaffoldDevAppOptions = {},
): Promise<CreateResult> {
  assertValidAppId(appId);
  if (appId.startsWith("@")) {
    throw new Error(
      `scaffoldDevApp: scoped ids are assigned by App Store publishing; create with an unscoped local app id.`,
    );
  }
  if (!rootPath || !isAbsolute(rootPath)) {
    throw new Error(
      `scaffoldDevApp: rootPath must be an absolute path (got ${JSON.stringify(rootPath)}).`,
    );
  }
  if (await isDirectoryNonEmpty(rootPath)) {
    throw new Error(`App directory ${rootPath} already exists and is non-empty.`);
  }

  const templateDir = options.templateDir ?? getAppTemplateDir(options.template ?? "default");
  await materializeTemplate(templateDir, rootPath, {
    appId,
    appName: appIdToDisplayName(appId),
  });

  log.info("scaffolded dev app", {
    appId,
    rootPath,
    templateDir,
    template: options.template ?? "default",
  });

  return { appId, created: true, rootPath };
}
