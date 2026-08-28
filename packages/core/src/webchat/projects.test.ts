import { afterEach, describe, expect, it } from "@rstest/core";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createWebchatProject,
  ensureWebchatProjectExists,
  getWebchatProjectDisplayName,
  listWebchatProjects,
  normalizeSelectedWebchatProjectPath,
  normalizeWebchatProjectPath,
  resolveWebchatContinuationWorkingDir,
  resolveWebchatWorkingDir,
  resolveWebchatProjectPath,
} from "./projects.js";

describe("webchat project helpers", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("lists only first-level project directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "rome-webchat-projects-"));
    tempRoots.push(root);
    mkdirSync(join(root, "alpha"));
    mkdirSync(join(root, "beta"));
    writeFileSync(join(root, "README.txt"), "ignore", "utf-8");

    const catalog = await listWebchatProjects(root);

    expect(catalog.rootPath).toBe(root);
    expect(catalog.projects).toEqual([
      { name: "default", path: join(root, "default") },
      { name: "alpha", path: join(root, "alpha") },
      { name: "beta", path: join(root, "beta") },
    ]);
  });

  it("creates and reports the default working directory from the projects root", async () => {
    const root = mkdtempSync(join(tmpdir(), "rome-webchat-projects-"));
    tempRoots.push(root);

    const catalog = await listWebchatProjects(root);

    expect(catalog.defaultPath).toBe(join(root, "default"));
    expect(catalog.projects).toEqual([{ name: "default", path: join(root, "default") }]);
  });

  it("creates a new project folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "rome-webchat-projects-"));
    tempRoots.push(root);

    await expect(createWebchatProject("new-app", root)).resolves.toEqual({
      name: "new-app",
      path: join(root, "new-app"),
    });

    await expect(ensureWebchatProjectExists("new-app", root)).resolves.toBe(join(root, "new-app"));
  });

  it("normalizes nested relative project paths", () => {
    expect(normalizeWebchatProjectPath(" landingpage/content ")).toBe("landingpage/content");
    expect(getWebchatProjectDisplayName("landingpage/content")).toBe("content");
  });

  it("rejects unsafe or empty project paths", () => {
    expect(() => normalizeWebchatProjectPath("")).toThrow("Project path is required");
    expect(() => normalizeWebchatProjectPath("/foo/bar")).toThrow(
      "Project path must be a relative folder path",
    );
    expect(() => normalizeWebchatProjectPath("foo/../bar")).toThrow(
      "Project path must not contain empty, current, or parent segments",
    );
    expect(() => normalizeWebchatProjectPath("foo//bar")).toThrow(
      "Project path must not contain empty, current, or parent segments",
    );
  });

  it("normalizes an empty selection to the default project", () => {
    expect(normalizeSelectedWebchatProjectPath()).toBe("default");
    expect(normalizeSelectedWebchatProjectPath("")).toBe("default");
    expect(normalizeSelectedWebchatProjectPath(" alpha ")).toBe("alpha");
    expect(normalizeSelectedWebchatProjectPath(" landingpage/content ")).toBe(
      "landingpage/content",
    );
  });

  it("rejects creating the default project because it already exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "rome-webchat-projects-"));
    tempRoots.push(root);

    await expect(createWebchatProject("default", root)).rejects.toThrow(
      'Project "default" already exists',
    );
  });

  it("resolves a valid project path under the projects root", () => {
    expect(resolveWebchatProjectPath("alpha", "/tmp/projects")).toBe("/tmp/projects/alpha");
    expect(resolveWebchatProjectPath("landingpage/content", "/tmp/projects")).toBe(
      "/tmp/projects/landingpage/content",
    );
  });

  it("resolves the default project inside the projects root", async () => {
    const root = mkdtempSync(join(tmpdir(), "rome-webchat-projects-"));
    tempRoots.push(root);

    await expect(resolveWebchatWorkingDir("default", root)).resolves.toBe(join(root, "default"));
  });

  describe("resolveWebchatContinuationWorkingDir", () => {
    it("resolves a deferred continuation back to the session's own project dir", async () => {
      const root = mkdtempSync(join(tmpdir(), "rome-webchat-projects-"));
      tempRoots.push(root);
      const repo = {
        getSession: async (id: string) =>
          id === "sess-romeos" ? { projectName: "romeos", projectPath: "romeos" } : null,
      };

      await expect(
        resolveWebchatContinuationWorkingDir("webchat", "sess-romeos", repo, root),
      ).resolves.toBe(join(root, "romeos"));
    });

    it("falls back to projectName when projectPath is null", async () => {
      const root = mkdtempSync(join(tmpdir(), "rome-webchat-projects-"));
      tempRoots.push(root);
      const repo = {
        getSession: async () => ({ projectName: "romeos", projectPath: null }),
      };

      await expect(
        resolveWebchatContinuationWorkingDir("webchat", "sess-x", repo, root),
      ).resolves.toBe(join(root, "romeos"));
    });

    it("returns undefined for non-webchat channels (no project concept)", async () => {
      const repo = {
        getSession: async () => {
          throw new Error("should not be queried for non-webchat channels");
        },
      };

      await expect(
        resolveWebchatContinuationWorkingDir("telegram", "thread-1", repo),
      ).resolves.toBeUndefined();
    });

    it("returns undefined for an unknown thread, leaving the default-dir fallback", async () => {
      const repo = { getSession: async () => null };

      await expect(
        resolveWebchatContinuationWorkingDir("webchat", "missing", repo),
      ).resolves.toBeUndefined();
    });
  });
});
