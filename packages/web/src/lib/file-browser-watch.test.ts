import { describe, expect, it, rs } from "@rstest/core";
import {
  createFileBrowserEventsUrl,
  findFileBrowserTreeNode,
  getAbsentDeletedWatchPaths,
  getFileBrowserWatchPaths,
  shouldReloadSelectedWatchFile,
  type FileBrowserWatchTreeNode,
} from "./file-browser-watch";

const refreshedTree = [
  {
    children: [
      { path: "projects/app/src/index.ts", type: "file" },
      { path: "projects/app/src/main.ts", type: "file" },
    ],
    path: "projects/app/src",
    type: "directory",
  },
  { path: "projects/notes.md", type: "file" },
] satisfies FileBrowserWatchTreeNode[];

describe("file browser watch reconciliation", () => {
  it("builds a stable watch list from the logical root and expanded folders", () => {
    expect(
      getFileBrowserWatchPaths(
        "projects",
        new Set(["projects/app/src", "memory/private", "projects/app", "projects"]),
      ),
    ).toEqual(["projects", "projects/app", "projects/app/src"]);
  });

  it("keeps the selected folder and selected file parent in the watch list", () => {
    expect(
      getFileBrowserWatchPaths("projects", new Set(["projects/app"]), {
        selectedFilePath: "projects/search-result/src/index.ts",
        selectedFolderPath: "projects/collapsed-folder",
      }),
    ).toEqual([
      "projects",
      "projects/app",
      "projects/collapsed-folder",
      "projects/search-result/src",
    ]);
  });

  it("encodes watch paths into the events URL", () => {
    expect(createFileBrowserEventsUrl("/api/memory", ["memory", "memory/Research Notes"])).toBe(
      "/api/memory/events?watch=memory&watch=memory%2FResearch+Notes",
    );
  });

  it("does not clear a deleted path that is replaced in the same batch", async () => {
    const pathExists = rs.fn(async () => false);

    await expect(
      getAbsentDeletedWatchPaths(
        [
          {
            at: 1,
            kind: "unlink",
            logicalRoot: "projects",
            path: "projects/app/src/index.ts",
          },
          {
            at: 2,
            kind: "add",
            logicalRoot: "projects",
            path: "projects/app/src/index.ts",
          },
        ],
        pathExists,
      ),
    ).resolves.toEqual([]);
    expect(pathExists).not.toHaveBeenCalled();
  });

  it("checks same-path file to directory replacements before recovering", async () => {
    const pathExists = rs.fn(async () => false);

    await expect(
      getAbsentDeletedWatchPaths(
        [
          {
            at: 1,
            kind: "unlink",
            logicalRoot: "projects",
            path: "projects/app/src/index.ts",
          },
          {
            at: 2,
            kind: "addDir",
            logicalRoot: "projects",
            path: "projects/app/src/index.ts",
          },
        ],
        pathExists,
        {
          refreshedTree: [
            {
              path: "projects/app/src/index.ts",
              type: "directory",
            },
          ],
        },
      ),
    ).resolves.toEqual(["projects/app/src/index.ts"]);
    expect(pathExists).toHaveBeenCalledWith("projects/app/src/index.ts", "unlink");
  });

  it("checks same-path directory to file replacements before recovering", async () => {
    const pathExists = rs.fn(async () => false);

    await expect(
      getAbsentDeletedWatchPaths(
        [
          {
            at: 1,
            kind: "unlinkDir",
            logicalRoot: "projects",
            path: "projects/app/src",
          },
          {
            at: 2,
            kind: "add",
            logicalRoot: "projects",
            path: "projects/app/src",
          },
        ],
        pathExists,
        {
          refreshedTree: [
            {
              path: "projects/app/src",
              type: "file",
            },
          ],
        },
      ),
    ).resolves.toEqual(["projects/app/src"]);
    expect(pathExists).toHaveBeenCalledWith("projects/app/src", "unlinkDir");
  });

  it("returns deleted paths that are absent after an explicit existence check", async () => {
    const pathExists = rs.fn(async () => false);

    await expect(
      getAbsentDeletedWatchPaths(
        [
          {
            at: 1,
            kind: "unlink",
            logicalRoot: "projects",
            path: "projects/app/src/removed.ts",
          },
          {
            at: 2,
            kind: "change",
            logicalRoot: "projects",
            path: "projects/notes.md",
          },
        ],
        pathExists,
      ),
    ).resolves.toEqual(["projects/app/src/removed.ts"]);
    expect(pathExists).toHaveBeenCalledWith("projects/app/src/removed.ts", "unlink");
  });

  it("checks existence when an add is followed by a delete in the same batch", async () => {
    const pathExists = rs.fn(async () => false);

    await expect(
      getAbsentDeletedWatchPaths(
        [
          {
            at: 1,
            kind: "add",
            logicalRoot: "projects",
            path: "projects/app/src/index.ts",
          },
          {
            at: 2,
            kind: "unlink",
            logicalRoot: "projects",
            path: "projects/app/src/index.ts",
          },
        ],
        pathExists,
      ),
    ).resolves.toEqual(["projects/app/src/index.ts"]);
    expect(pathExists).toHaveBeenCalledWith("projects/app/src/index.ts", "unlink");
  });

  it("does not clear a deleted path that still exists on disk", async () => {
    await expect(
      getAbsentDeletedWatchPaths(
        [
          {
            at: 1,
            kind: "unlink",
            logicalRoot: "projects",
            path: "projects/app/src/index.ts",
          },
        ],
        async () => true,
      ),
    ).resolves.toEqual([]);
  });

  it("does not probe a deleted path that is present in the refreshed tree", async () => {
    const pathExists = rs.fn(async () => false);

    await expect(
      getAbsentDeletedWatchPaths(
        [
          {
            at: 1,
            kind: "unlink",
            logicalRoot: "projects",
            path: "projects/app/src/index.ts",
          },
        ],
        pathExists,
        { refreshedTree },
      ),
    ).resolves.toEqual([]);
    expect(pathExists).not.toHaveBeenCalled();
  });

  it("collapses deleted descendants under a deleted directory before probing", async () => {
    const pathExists = rs.fn(async () => false);

    await expect(
      getAbsentDeletedWatchPaths(
        [
          {
            at: 1,
            kind: "unlink",
            logicalRoot: "projects",
            path: "projects/app/src/index.ts",
          },
          {
            at: 2,
            kind: "unlink",
            logicalRoot: "projects",
            path: "projects/app/src/main.ts",
          },
          {
            at: 3,
            kind: "unlinkDir",
            logicalRoot: "projects",
            path: "projects/app/src",
          },
        ],
        pathExists,
      ),
    ).resolves.toEqual(["projects/app/src"]);
    expect(pathExists).toHaveBeenCalledTimes(1);
    expect(pathExists).toHaveBeenCalledWith("projects/app/src", "unlinkDir");
  });

  it("finds nested nodes in a refreshed tree", () => {
    expect(findFileBrowserTreeNode(refreshedTree, "projects/app/src/main.ts")).toEqual({
      path: "projects/app/src/main.ts",
      type: "file",
    });
    expect(findFileBrowserTreeNode(refreshedTree, "projects/missing.ts")).toBeNull();
  });

  it("reloads the selected file after an atomic-save unlink/add sequence", () => {
    expect(
      shouldReloadSelectedWatchFile(
        [
          {
            at: 1,
            kind: "unlink",
            logicalRoot: "projects",
            path: "projects/app/src/index.ts",
          },
          {
            at: 2,
            kind: "add",
            logicalRoot: "projects",
            path: "projects/app/src/index.ts",
          },
        ],
        "projects/app/src/index.ts",
      ),
    ).toBe(true);
  });

  it("does not reload the selected file for a self-originated save event", () => {
    const isSelfOriginated = rs.fn(
      (event: { path: string }) => event.path === "projects/app/src/index.ts",
    );

    expect(
      shouldReloadSelectedWatchFile(
        [
          {
            at: 1,
            kind: "change",
            logicalRoot: "projects",
            path: "projects/app/src/index.ts",
          },
        ],
        "projects/app/src/index.ts",
        isSelfOriginated,
      ),
    ).toBe(false);
    expect(isSelfOriginated).toHaveBeenCalledTimes(1);
  });

  it("reloads the selected file when any matching event is not self-originated", () => {
    expect(
      shouldReloadSelectedWatchFile(
        [
          {
            at: 1,
            kind: "change",
            logicalRoot: "projects",
            path: "projects/app/src/index.ts",
          },
          {
            at: 2,
            kind: "change",
            logicalRoot: "projects",
            path: "projects/app/src/index.ts",
          },
        ],
        "projects/app/src/index.ts",
        (event) => event.at === 1,
      ),
    ).toBe(true);
  });
});
