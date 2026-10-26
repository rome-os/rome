import { afterAll, afterEach, describe, expect, it } from "@rstest/core";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getWebchatProjectDisplayName,
  normalizeSelectedWebchatProjectPath,
  normalizeWebchatProjectPath,
  resolveAgentProjectPath,
  resolveProjectWorkingDirWithinRoot,
  resolveWebchatContinuationDeviceFolder,
  resolveWebchatContinuationWorkingDir,
  resolveWebchatProjectPath,
} from "./projects.js";

describe("webchat project helpers", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
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

  it("resolves a valid project path under the projects root", () => {
    expect(resolveWebchatProjectPath("alpha", "/tmp/projects")).toBe("/tmp/projects/alpha");
    expect(resolveWebchatProjectPath("landingpage/content", "/tmp/projects")).toBe(
      "/tmp/projects/landingpage/content",
    );
  });

  describe("resolveWebchatContinuationDeviceFolder", () => {
    const folder = { deviceId: "mac", deviceName: "macbook", platform: "macos", path: "/w" };

    it("returns the webchat chat's device folder", async () => {
      const repo = {
        getSession: async (id: string) => (id === "chat-1" ? { deviceFolder: folder } : null),
      };
      await expect(
        resolveWebchatContinuationDeviceFolder("webchat", "chat-1", repo),
      ).resolves.toEqual(folder);
    });

    it("returns undefined without a folder, for unknown chats, and for other channels", async () => {
      const repo = {
        getSession: async (id: string) => (id === "plain" ? { deviceFolder: null } : null),
      };
      await expect(
        resolveWebchatContinuationDeviceFolder("webchat", "plain", repo),
      ).resolves.toBeUndefined();
      await expect(
        resolveWebchatContinuationDeviceFolder("webchat", "missing", repo),
      ).resolves.toBeUndefined();
      await expect(
        resolveWebchatContinuationDeviceFolder("telegram", "plain", repo),
      ).resolves.toBeUndefined();
    });
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

describe("resolveAgentProjectPath", () => {
  const root = mkdtempSync(join(tmpdir(), "rome-agent-projects-"));
  mkdirSync(join(root, "apps", "story-shelf"), { recursive: true });
  const known = ["default", "rome-oss"];

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("takes a path relative to the projects root", () => {
    expect(resolveAgentProjectPath(" rome-oss ", known, root)).toBe("rome-oss");
  });

  it("maps the absolute path the prompt lists to the relative project path", () => {
    expect(resolveAgentProjectPath(join(root, "rome-oss"), known, root)).toBe("rome-oss");
    expect(resolveAgentProjectPath(join(root, "apps", "story-shelf"), known, root)).toBe(
      "apps/story-shelf",
    );
  });

  it("accepts an existing folder that is not registered yet", () => {
    expect(resolveAgentProjectPath("apps/story-shelf", known, root)).toBe("apps/story-shelf");
  });

  it("names the valid values when the project is unknown or the path is invalid", () => {
    const hint = `Pass a path relative to the projects root ${root}, one of: default, rome-oss.`;
    expect(() => resolveAgentProjectPath("rome", known, root)).toThrow(
      `No project "rome". ${hint}`,
    );
    expect(() => resolveAgentProjectPath("/elsewhere/rome-oss", known, root)).toThrow(
      `Invalid project "/elsewhere/rome-oss": it is not inside the projects root. ${hint}`,
    );
    expect(() => resolveAgentProjectPath(root, known, root)).toThrow(hint);
    expect(() => resolveAgentProjectPath("rome-oss/../x", known, root)).toThrow(hint);
  });
});
