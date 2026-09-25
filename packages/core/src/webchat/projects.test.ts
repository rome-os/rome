import { afterEach, describe, expect, it } from "@rstest/core";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
  resolveProjectWorkingDirWithinRoot,
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

describe("resolveProjectWorkingDirWithinRoot", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  function makeRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rome-project-working-dir-")));
    tempDirs.push(root);
    mkdirSync(join(root, "landingpage", "content"), { recursive: true });
    return root;
  }

  it("resolves a relative project path and an absolute path inside the root", async () => {
    const root = makeRoot();
    const expected = join(root, "landingpage", "content");

    await expect(resolveProjectWorkingDirWithinRoot("landingpage/content", root)).resolves.toBe(
      expected,
    );
    await expect(resolveProjectWorkingDirWithinRoot(` ${expected} `, root)).resolves.toBe(expected);
    await expect(
      resolveProjectWorkingDirWithinRoot(join(root, "landingpage", "..", "landingpage"), root),
    ).resolves.toBe(join(root, "landingpage"));
  });

  it("rejects the root itself and paths that leave it", async () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), "rome-project-outside-"));
    tempDirs.push(outside);

    for (const requested of [root, outside, join(root, ".."), "/etc"]) {
      await expect(resolveProjectWorkingDirWithinRoot(requested, root)).rejects.toThrow(
        "is not inside the projects root",
      );
    }
    for (const requested of ["", "../outside", "landingpage/../..", "a\\b"]) {
      await expect(resolveProjectWorkingDirWithinRoot(requested, root)).rejects.toThrow();
    }
  });

  it("rejects a symlink escaping the root and returns the real dir of one inside it", async () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), "rome-project-outside-"));
    tempDirs.push(outside);
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(join(root, "landingpage"), join(root, "alias"));

    await expect(resolveProjectWorkingDirWithinRoot("escape", root)).rejects.toThrow(
      "is not inside the projects root",
    );
    await expect(resolveProjectWorkingDirWithinRoot("alias", root)).resolves.toBe(
      join(root, "landingpage"),
    );
  });

  it("accepts the real path of a project when the root is reached through a symlink", async () => {
    const root = makeRoot();
    const linkParent = mkdtempSync(join(tmpdir(), "rome-project-link-"));
    tempDirs.push(linkParent);
    const linkedRoot = join(linkParent, "projects");
    symlinkSync(root, linkedRoot);
    const expected = join(root, "landingpage");

    for (const requested of [expected, join(linkedRoot, "landingpage"), "landingpage"]) {
      await expect(resolveProjectWorkingDirWithinRoot(requested, linkedRoot)).resolves.toBe(
        expected,
      );
    }
  });

  it("rejects a missing directory and a file", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "notes.txt"), "not a project", "utf-8");

    await expect(resolveProjectWorkingDirWithinRoot("missing", root)).rejects.toThrow(
      "does not exist",
    );
    await expect(resolveProjectWorkingDirWithinRoot("notes.txt", root)).rejects.toThrow(
      "is not a directory",
    );
  });
});
