import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppCatalog } from "./catalog.js";
import { getInternalApiBaseUrl } from "../internal-api-url.js";
import {
  getCoreRoot,
  getCustomAppAuthoringRoot,
  getProfileDir,
  getProfileInstalledAppsDir,
  getProfileMemoryDir,
  getProjectRoot,
  getRepoAppsDir,
  getRepoDocsDir,
} from "../paths.js";
import { resolveWebchatProjectPath } from "../webchat/projects.js";
import { projectSummary, type PromptMemory, type PromptSources } from "../agent/index.js";

/**
 * Reads a system prompt's material from the profile, the repo and the app catalog.
 *
 * @param emailAddress Rome's own provisioned inbox address. A getter because the
 * address is provisioned asynchronously at boot, after this is constructed.
 * @param publicOrigin This instance's own public web origin (`https://<slug>.<domain>`),
 * undefined when it has no public domain. A getter because a blank hosted
 * instance adopts its tenant identity at runtime.
 */
export function createPromptSources(options: {
  apps: Pick<AppCatalog, "listResolved" | "subscribe">;
  emailAddress?: () => string | undefined;
  publicOrigin?: () => string | undefined;
}): PromptSources {
  const projectRoot = getProjectRoot();
  const coreRoot = getCoreRoot();
  const customAppAuthoringDir = getCustomAppAuthoringRoot();
  const profileDir = getProfileDir();
  const profileMemoryDir = getProfileMemoryDir();
  const installedAppsDir = getProfileInstalledAppsDir();
  const repoAppsDir = getRepoAppsDir(projectRoot);
  const repoDocsDir = getRepoDocsDir(projectRoot);
  const docsDir = existsSync(repoDocsDir) ? repoDocsDir : null;

  /**
   * Where a memory project's files live on disk. `memory/projects/<name>` only
   * mirrors `projects/<name>` best-effort (see memory/projects/README.md), and
   * app projects keep their source under the custom app authoring root, so
   * point at whichever directory actually exists, and show no path rather
   * than a made-up one.
   */
  function projectLocation(name: string): string | null {
    for (const candidate of [resolveWebchatProjectPath(name), join(customAppAuthoringDir, name)]) {
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        // Missing or unreadable, so try the next candidate.
      }
    }
    return null;
  }

  function memoryProjects(): PromptMemory["projects"] {
    const projectsDir = join(profileMemoryDir, "projects");
    let names: string[];
    try {
      names = readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }

    return names.flatMap((name) => {
      const content = readFileGracefully(join(projectsDir, name, "PROJECT.md"));
      const summary = content ? projectSummary(content) : null;
      return summary ? [{ name, location: projectLocation(name), summary }] : [];
    });
  }

  return {
    material() {
      const publicOrigin = options.publicOrigin?.()?.trim();
      const emailAddress = options.emailAddress?.()?.trim();
      return {
        charter: readFileGracefully(join(coreRoot, "CHARTER.md")),
        identity: readFileGracefully(join(profileMemoryDir, "IDENTITY.md")),
        runtime: {
          profileDir,
          profileMemoryDir,
          customAppAuthoringDir,
          installedAppsDir,
          repoAppsDir,
          internalApiBaseUrl: getInternalApiBaseUrl(),
          docsDir,
          ...(publicOrigin ? { publicOrigin } : {}),
          ...(emailAddress ? { emailAddress } : {}),
        },
        installedApps: options.apps
          .listResolved()
          .map((app) => ({ appId: app.appId, description: app.manifest.description })),
      };
    },
    memory() {
      return {
        index: readFileGracefully(join(profileMemoryDir, "MEMORY.md")),
        projects: memoryProjects(),
      };
    },
    // The installed-app list in the fixed part is a snapshot, and `listResolved()`
    // already excludes disabled apps, so a runtime enable, disable, install or
    // uninstall must reach the next session opened. Boot's refresh storm needs
    // no signal: the composition root subscribes after it, and nothing is held
    // before the first turn.
    onChanged(listener) {
      options.apps.subscribe(function promptPrefixCacheInvalidator() {
        listener();
      });
    },
  };
}

function readFileGracefully(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}
