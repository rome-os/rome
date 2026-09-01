import { describe, expect, it } from "@rstest/core";
import {
  mergeTreeNodesPreservingLoadedChildren,
  replaceTreeNodeChildren,
  type FileBrowserTreeNode,
} from "./file-browser-tree";

describe("file browser tree helpers", () => {
  it("preserves loaded children for expanded folders when a depth-limited root refresh omits them", () => {
    const existingTree: FileBrowserTreeNode[] = [
      {
        children: [{ name: "a.txt", path: "projects/A/a.txt", type: "file" }],
        name: "A",
        path: "projects/A",
        type: "directory",
      },
      {
        children: [{ name: "old.txt", path: "projects/B/old.txt", type: "file" }],
        name: "B",
        path: "projects/B",
        type: "directory",
      },
    ];

    const refreshedRoot: FileBrowserTreeNode[] = [
      { name: "A", path: "projects/A", type: "directory" },
      { name: "B", path: "projects/B", type: "directory" },
      { name: "top.txt", path: "projects/top.txt", type: "file" },
    ];

    expect(
      mergeTreeNodesPreservingLoadedChildren(refreshedRoot, existingTree, {
        preserveChildrenForPaths: new Set(["projects/A"]),
      }),
    ).toEqual([
      {
        children: [{ name: "a.txt", path: "projects/A/a.txt", type: "file" }],
        name: "A",
        path: "projects/A",
        type: "directory",
      },
      {
        name: "B",
        path: "projects/B",
        type: "directory",
      },
      { name: "top.txt", path: "projects/top.txt", type: "file" },
    ]);
  });

  it("clears loaded children for collapsed folders when a depth-limited root refresh omits them", () => {
    const existingTree: FileBrowserTreeNode[] = [
      {
        children: [{ name: "stale.txt", path: "projects/A/stale.txt", type: "file" }],
        name: "A",
        path: "projects/A",
        type: "directory",
      },
    ];

    expect(
      mergeTreeNodesPreservingLoadedChildren(
        [{ name: "A", path: "projects/A", type: "directory" }],
        existingTree,
        { preserveChildrenForPaths: new Set() },
      ),
    ).toEqual([{ name: "A", path: "projects/A", type: "directory" }]);
  });

  it("still replaces directly refreshed ancestor children", () => {
    const tree: FileBrowserTreeNode[] = [
      {
        children: [{ name: "old.txt", path: "projects/B/old.txt", type: "file" }],
        name: "B",
        path: "projects/B",
        type: "directory",
      },
    ];

    expect(
      replaceTreeNodeChildren(tree, "projects/B", [
        { name: "new.txt", path: "projects/B/new.txt", type: "file" },
      ]),
    ).toEqual([
      {
        children: [{ name: "new.txt", path: "projects/B/new.txt", type: "file" }],
        name: "B",
        path: "projects/B",
        type: "directory",
      },
    ]);
  });

  it("keeps a refreshed source branch empty during a later destination reveal", () => {
    const existingTree: FileBrowserTreeNode[] = [
      {
        children: [{ name: "foo.txt", path: "projects/A/foo.txt", type: "file" }],
        name: "A",
        path: "projects/A",
        type: "directory",
      },
      {
        children: [{ name: "bar.txt", path: "projects/B/bar.txt", type: "file" }],
        name: "B",
        path: "projects/B",
        type: "directory",
      },
    ];

    const afterSourceRefresh = replaceTreeNodeChildren(existingTree, "projects/A", []);
    const afterRootRefresh = mergeTreeNodesPreservingLoadedChildren(
      [
        { name: "A", path: "projects/A", type: "directory" },
        { name: "B", path: "projects/B", type: "directory" },
      ],
      afterSourceRefresh,
      { preserveChildrenForPaths: new Set(["projects/A", "projects/B"]) },
    );

    expect(
      replaceTreeNodeChildren(afterRootRefresh, "projects/B", [
        { name: "bar.txt", path: "projects/B/bar.txt", type: "file" },
        { name: "foo.txt", path: "projects/B/foo.txt", type: "file" },
      ]),
    ).toEqual([
      {
        children: [],
        name: "A",
        path: "projects/A",
        type: "directory",
      },
      {
        children: [
          { name: "bar.txt", path: "projects/B/bar.txt", type: "file" },
          { name: "foo.txt", path: "projects/B/foo.txt", type: "file" },
        ],
        name: "B",
        path: "projects/B",
        type: "directory",
      },
    ]);
  });
});
