import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCustomAppAuthoringRoot, getProjectRoot, getRepoAppsDir } from "../paths.js";
import { appIdToPathSegment } from "./packaging/app-id.js";

export interface AppAuthoringLocation {
  appId: string;
  rootPath: string;
  source: "seed" | "custom";
}

export interface ResolveAuthoringAppRootOptions {
  projectRoot?: string;
  customAppsRoot?: string;
  preferCustom?: boolean;
}

export function getCoreAgentsRoot(projectRoot: string = getProjectRoot()): string {
  return join(projectRoot, "packages", "core", "agents");
}

export function getFirstPartySeedAppPath(projectRoot: string, appId: string): string {
  return join(getRepoAppsDir(projectRoot), appId);
}

export function getCustomAppAuthoringPath(
  appId: string,
  customAppsRoot: string = getCustomAppAuthoringRoot(),
): string {
  return join(customAppsRoot, appIdToPathSegment(appId));
}

export function isRomeAppRoot(appRoot: string): boolean {
  return existsSync(join(appRoot, "app.yaml"));
}

export function resolveAuthoringAppRoot(
  appId: string,
  options: ResolveAuthoringAppRootOptions = {},
): AppAuthoringLocation {
  const projectRoot = options.projectRoot ?? getProjectRoot();
  const customAppsRoot = options.customAppsRoot ?? getCustomAppAuthoringRoot();
  const seedRootPath = getFirstPartySeedAppPath(projectRoot, appId);
  const customRootPath = getCustomAppAuthoringPath(appId, customAppsRoot);
  const candidates =
    (options.preferCustom ?? true)
      ? [
          { rootPath: customRootPath, source: "custom" as const },
          { rootPath: seedRootPath, source: "seed" as const },
        ]
      : [
          { rootPath: seedRootPath, source: "seed" as const },
          { rootPath: customRootPath, source: "custom" as const },
        ];

  for (const candidate of candidates) {
    if (isRomeAppRoot(candidate.rootPath)) {
      return {
        appId,
        rootPath: candidate.rootPath,
        source: candidate.source,
      };
    }
  }

  throw new Error(
    `App "${appId}" was not found in the custom authoring root (${customAppsRoot}) or the seed apps root (${getRepoAppsDir(projectRoot)}).`,
  );
}
