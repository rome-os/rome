import { existsSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { appIdToPathSegment } from "./apps/packaging/app-id.js";

const DEFAULT_AGENT_WORKING_DIR_NAME = "default";

function isProjectRoot(candidate: string): boolean {
  return (
    existsSync(join(candidate, "pnpm-workspace.yaml")) &&
    existsSync(join(candidate, "packages", "core", "package.json"))
  );
}

function findProjectRoot(startDir: string): string | null {
  let current = resolve(startDir);

  while (true) {
    if (isProjectRoot(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function readEnvPath(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  // Guard against accidental `process.env.X = undefined` (Node coerces to "undefined")
  // or similarly mis-set shell vars.
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return undefined;
  return trimmed;
}

export function getProjectRoot(): string {
  const configuredRoot = readEnvPath("ROME_PROJECT_ROOT") ?? readEnvPath("ROME_APP_DIR");
  if (configuredRoot) {
    return resolve(configuredRoot);
  }

  return findProjectRoot(process.cwd()) ?? resolve(process.cwd(), "../..");
}

export function getCoreRoot(): string {
  const configuredRoot = readEnvPath("ROME_CORE_ROOT");
  if (configuredRoot) {
    return resolve(configuredRoot);
  }
  return join(getProjectRoot(), "packages", "core");
}

export function getDefaultAgentWorkingDir(): string {
  return join(getProjectsRoot(), DEFAULT_AGENT_WORKING_DIR_NAME);
}

export async function ensureDefaultAgentWorkingDir(): Promise<string> {
  const workingDir = getDefaultAgentWorkingDir();
  await mkdir(workingDir, { recursive: true });
  return workingDir;
}

export function getProjectsRoot(): string {
  const configuredRoot =
    readEnvPath("ROME_PROJECTS_ROOT") ?? readEnvPath("ROME_WEBCHAT_PROJECTS_ROOT");
  return configuredRoot ?? join(getProfileDir(), "projects");
}

export function ensureProjectsRootInitialized(): string {
  const projectsRoot = getProjectsRoot();
  mkdirSync(projectsRoot, { recursive: true });
  return projectsRoot;
}

export function getProfile(): string {
  return process.env.ROME_PROFILE || "default";
}

export function getProfileDir(): string {
  return join(homedir(), ".rome", getProfile());
}

export function getProfileDevAppsDir(): string {
  return join(getProfileDir(), "projects", "apps");
}

export function ensureProfileDevAppsDirInitialized(): string {
  const devAppsDir = getProfileDevAppsDir();
  mkdirSync(devAppsDir, { recursive: true });
  return devAppsDir;
}

export function getCustomAppAuthoringRoot(): string {
  return resolve(process.env.ROME_APP_AUTHORING_ROOT ?? getProfileDevAppsDir());
}

/**
 * Per-profile destination for seeded example/reference apps
 * (`~/.rome/<profile>/projects/example-apps`). Kept separate from the guardian's
 * own authoring dir (`projects/apps`) so seeded starters never clutter the apps
 * they author. See `profile-example-apps.ts`.
 */
export function getProfileExampleAppsDir(): string {
  return join(getProfileDir(), "projects", "example-apps");
}

export function getRepoAppsDir(projectRoot: string = getProjectRoot()): string {
  return join(projectRoot, "rome_apps");
}

/**
 * Source location of the example/reference apps. Unlike `rome_apps/*` (first-party
 * apps packed by `pnpm build:apps` and installed at boot), these are NOT installed:
 * they are read as skill references and seeded into the per-profile example-apps
 * dir as editable starters (see `profile-example-apps.ts`). Shipped into the Docker
 * runtime workspace as plain source by `scripts/docker/prepare-runtime-workspace.mjs`
 * (not a workspace member), so this stays resolvable off the project root at runtime.
 */
export function getExampleAppsDir(projectRoot: string = getProjectRoot()): string {
  return join(projectRoot, "example_apps");
}

/**
 * Build-output location of a first-party app's pre-packed artifact. Produced by
 * `pnpm build:apps` at build time and installed (not packed) at boot. Lives
 * under `dist/` so it is gitignored / dockerignored as build output.
 */
export function getFirstPartyArtifactDir(
  appId: string,
  projectRoot: string = getProjectRoot(),
): string {
  return join(projectRoot, "dist", "first-party-artifacts", appId);
}

/** Which bundled scaffold `op: "create"` materializes. `default` is the generic
 * hello-world app; `workflow` is the workflow app shell (a `runWorkflow`
 * definition + run action + trigger UI). */
export type AppTemplateKind = "default" | "workflow";

/**
 * Resolve the directory containing a new-app template tree.
 *
 * Lookup order (per kind):
 *   1. `ROME_APP_TEMPLATE_DIR` env override — `default` kind only (tests / packagers).
 *   2. `<projectRoot>/packages/app-template/<subdir>` — dev / monorepo layout.
 *   3. `<coreRoot>/dist/<distName>` — published bundle layout, where the template
 *      is copied as a static asset alongside `dist/index.js`.
 *
 * Both templates ship the same two ways (the whole `packages/app-template`
 * package is included in the runtime workspace, and `bundle-docker-core.mjs`
 * copies each into `dist/`), so a scaffold works identically in dev and prod.
 *
 * Throws when none of the candidates exist; callers should surface this loudly
 * because `op: "create"` cannot proceed without a template.
 */
export function getAppTemplateDir(kind: AppTemplateKind = "default"): string {
  if (kind === "default") {
    const override = readEnvPath("ROME_APP_TEMPLATE_DIR");
    if (override) {
      return resolve(override);
    }
  }

  const subdir = kind === "workflow" ? "workflow" : "template";
  const distName = kind === "workflow" ? "app-template-workflow" : "app-template";
  const candidates = [
    join(getProjectRoot(), "packages", "app-template", subdir),
    join(getCoreRoot(), "dist", distName),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "app.yaml"))) {
      return candidate;
    }
  }

  throw new Error(
    `App template directory ("${kind}") not found. Looked in:\n  - ${candidates.join("\n  - ")}\n` +
      (kind === "default" ? "Set ROME_APP_TEMPLATE_DIR to override." : ""),
  );
}

export function getProfileAppsDir(): string {
  return join(getProfileDir(), "apps");
}

export function getProfileInstalledAppsDir(): string {
  return join(getProfileAppsDir(), "installed");
}

export function getProfileAppDataDir(appId: string): string {
  return join(getProfileAppsDir(), "data", appIdToPathSegment(appId));
}

export function getProfileAppsLockfilePath(): string {
  return join(getProfileDir(), "apps.lock.json");
}

export function getProfileAppsRuntimeStatusPath(): string {
  return join(getProfileAppsDir(), "runtime-status.json");
}

export function getProfileMemoryDir(): string {
  return join(getProfileDir(), "memory");
}

export function getDefaultSqlitePath(): string {
  return join(getProfileDir(), "rome.db");
}

export function getWorktreesDir(): string {
  return join(getProfileDir(), "worktrees");
}

export function getDefaultWhatsappAuthPath(): string {
  return join(getProfileDir(), "whatsapp-auth");
}
