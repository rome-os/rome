import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import {
  getCustomAppAuthoringRoot,
  getDefaultAgentWorkingDir,
  ensureProfileDevAppsDirInitialized,
  getProfileAppDataDir,
  getProfileAppInstallDir,
  getProfileAppsDir,
  getProfileAppsLockfilePath,
  getProfileAppsRuntimeStatusPath,
  getProfileDevAppsDir,
  getProfileInstalledAppsDir,
  getProjectRoot,
  getProjectsRoot,
  getRepoAppsDir,
} from "./paths.js";

const originalCwd = process.cwd();
const originalAppDir = process.env.ROME_APP_DIR;
const originalAuthoringRoot = process.env.ROME_APP_AUTHORING_ROOT;
const originalProjectRoot = process.env.ROME_PROJECT_ROOT;
const originalProjectsRoot = process.env.ROME_PROJECTS_ROOT;
const originalWebchatProjectsRoot = process.env.ROME_WEBCHAT_PROJECTS_ROOT;
const originalProfile = process.env.ROME_PROFILE;
const profileDirsToCleanup = new Set<string>();

afterEach(() => {
  process.chdir(originalCwd);
  for (const profileDir of profileDirsToCleanup) {
    rmSync(profileDir, { recursive: true, force: true });
  }
  profileDirsToCleanup.clear();

  if (originalAppDir === undefined) {
    delete process.env.ROME_APP_DIR;
  } else {
    process.env.ROME_APP_DIR = originalAppDir;
  }

  if (originalAuthoringRoot === undefined) {
    delete process.env.ROME_APP_AUTHORING_ROOT;
  } else {
    process.env.ROME_APP_AUTHORING_ROOT = originalAuthoringRoot;
  }

  if (originalProjectRoot === undefined) {
    delete process.env.ROME_PROJECT_ROOT;
  } else {
    process.env.ROME_PROJECT_ROOT = originalProjectRoot;
  }

  if (originalProjectsRoot === undefined) {
    delete process.env.ROME_PROJECTS_ROOT;
  } else {
    process.env.ROME_PROJECTS_ROOT = originalProjectsRoot;
  }

  if (originalWebchatProjectsRoot === undefined) {
    delete process.env.ROME_WEBCHAT_PROJECTS_ROOT;
  } else {
    process.env.ROME_WEBCHAT_PROJECTS_ROOT = originalWebchatProjectsRoot;
  }

  if (originalProfile === undefined) {
    delete process.env.ROME_PROFILE;
  } else {
    process.env.ROME_PROFILE = originalProfile;
  }
});

describe("getProjectRoot", () => {
  it("prefers explicit project root environment configuration", () => {
    process.env.ROME_PROJECT_ROOT = "/tmp/rome-env-root";
    delete process.env.ROME_APP_DIR;

    expect(getProjectRoot()).toBe("/tmp/rome-env-root");
  });

  it("discovers the repo root by walking upward from cwd", () => {
    delete process.env.ROME_PROJECT_ROOT;
    delete process.env.ROME_APP_DIR;

    const root = mkdtempSync(join(tmpdir(), "rome-paths-"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    mkdirSync(join(root, "packages", "core"), { recursive: true });
    writeFileSync(join(root, "packages", "core", "package.json"), "{}\n");
    mkdirSync(join(root, "apps", "web"), { recursive: true });

    process.chdir(join(root, "apps", "web"));

    expect(getProjectRoot()).toBe(realpathSync(root));
  });

  it("ignores nested standalone pnpm workspaces inside the repo", () => {
    delete process.env.ROME_PROJECT_ROOT;
    delete process.env.ROME_APP_DIR;

    const root = mkdtempSync(join(tmpdir(), "rome-paths-"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    mkdirSync(join(root, "packages", "core"), { recursive: true });
    writeFileSync(join(root, "packages", "core", "package.json"), "{}\n");
    mkdirSync(join(root, "rome_apps", "briefing", "src"), { recursive: true });
    writeFileSync(
      join(root, "rome_apps", "briefing", "pnpm-workspace.yaml"),
      "allowBuilds:\n  esbuild: true\n",
    );

    process.chdir(join(root, "rome_apps", "briefing", "src"));

    expect(getProjectRoot()).toBe(realpathSync(root));
  });
});

describe("profile app paths", () => {
  it("derives the default agent working directory from the active profile projects root", () => {
    delete process.env.ROME_PROJECTS_ROOT;
    delete process.env.ROME_WEBCHAT_PROJECTS_ROOT;
    process.env.ROME_PROFILE = "guardian";

    const expected = join(homedir(), ".rome", "guardian", "projects");
    expect(getProjectsRoot()).toBe(expected);
    expect(getDefaultAgentWorkingDir()).toBe(join(expected, "default"));
  });

  it("uses the default profile when no active profile is configured", () => {
    delete process.env.ROME_PROJECTS_ROOT;
    delete process.env.ROME_WEBCHAT_PROJECTS_ROOT;
    delete process.env.ROME_PROFILE;

    const expected = join(homedir(), ".rome", "default", "projects");
    expect(getProjectsRoot()).toBe(expected);
    expect(getDefaultAgentWorkingDir()).toBe(join(expected, "default"));
  });

  it("allows the projects root to be overridden explicitly", () => {
    process.env.ROME_PROJECTS_ROOT = "/tmp/rome-projects-root";

    expect(getProjectsRoot()).toBe("/tmp/rome-projects-root");
    expect(getDefaultAgentWorkingDir()).toBe("/tmp/rome-projects-root/default");
  });

  it("falls back to the existing webchat projects root override when present", () => {
    delete process.env.ROME_PROJECTS_ROOT;
    process.env.ROME_WEBCHAT_PROJECTS_ROOT = "/tmp/rome-webchat-projects-root";

    expect(getProjectsRoot()).toBe("/tmp/rome-webchat-projects-root");
    expect(getDefaultAgentWorkingDir()).toBe("/tmp/rome-webchat-projects-root/default");
  });

  it("derives installed, data, and lockfile paths under the active profile", () => {
    process.env.ROME_PROFILE = "guardian";

    expect(getProfileDevAppsDir()).toContain("/.rome/guardian/projects/apps");
    expect(getCustomAppAuthoringRoot()).toContain("/.rome/guardian/projects/apps");
    expect(getProfileAppsDir()).toContain("/.rome/guardian/apps");
    expect(getProfileInstalledAppsDir()).toContain("/.rome/guardian/apps/installed");
    expect(getProfileAppInstallDir("coding")).toContain("/.rome/guardian/apps/installed/coding");
    expect(getProfileAppDataDir("coding")).toContain("/.rome/guardian/apps/data/coding");
    expect(getProfileAppInstallDir("@foo/bar")).toContain(
      "/.rome/guardian/apps/installed/%40foo%2Fbar",
    );
    expect(getProfileAppDataDir("@foo/bar")).toContain("/.rome/guardian/apps/data/%40foo%2Fbar");
    expect(getProfileAppsLockfilePath()).toContain("/.rome/guardian/apps.lock.json");
    expect(getProfileAppsRuntimeStatusPath()).toContain("/.rome/guardian/apps/runtime-status.json");
  });

  it("initializes the profile dev apps directory", () => {
    const profile = `paths-test-${process.pid}-${Date.now()}`;
    const profileDir = join(homedir(), ".rome", profile);
    profileDirsToCleanup.add(profileDir);
    process.env.ROME_PROFILE = profile;

    const devAppsDir = ensureProfileDevAppsDirInitialized();

    expect(devAppsDir).toBe(join(profileDir, "projects", "apps"));
    expect(existsSync(devAppsDir)).toBe(true);
  });

  it("allows the custom authoring root to be overridden explicitly", () => {
    process.env.ROME_APP_AUTHORING_ROOT = "/tmp/rome-authoring-root";

    expect(getCustomAppAuthoringRoot()).toBe("/tmp/rome-authoring-root");
  });

  it("exposes the repo seed apps directory", () => {
    expect(getRepoAppsDir("/tmp/rome-project")).toBe("/tmp/rome-project/rome_apps");
  });
});
