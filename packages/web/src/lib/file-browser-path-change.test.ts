import { describe, expect, it } from "@rstest/core";
import { getFileBrowserPathChangeUpdate } from "./file-browser-path-change";

describe("file browser path change helpers", () => {
  it("reveals the renamed tree node even when another file is open", () => {
    expect(
      getFileBrowserPathChangeUpdate({
        newPath: "projects/A/new.md",
        oldPath: "projects/A/old.md",
        selectedFolderPath: null,
        selectedPath: "projects/notes/open.md",
        selectedTreePaths: ["projects/A/old.md"],
        selectionAnchorPath: "projects/A/old.md",
      }),
    ).toEqual({
      changedPathToReveal: "projects/A/new.md",
      selectedFolderPath: null,
      selectedPath: "projects/notes/open.md",
      selectedTreePaths: ["projects/A/new.md"],
      selectionAnchorPath: "projects/A/new.md",
    });
  });

  it("moves selected descendants under the new directory path", () => {
    expect(
      getFileBrowserPathChangeUpdate({
        newPath: "projects/B/folder",
        oldPath: "projects/A/folder",
        selectedFolderPath: "projects/A/folder/nested",
        selectedPath: "projects/A/folder/nested/file.md",
        selectedTreePaths: ["projects/A/folder", "projects/A/folder/nested/file.md"],
        selectionAnchorPath: "projects/A/folder/nested/file.md",
      }),
    ).toEqual({
      changedPathToReveal: "projects/B/folder",
      selectedFolderPath: "projects/B/folder/nested",
      selectedPath: "projects/B/folder/nested/file.md",
      selectedTreePaths: ["projects/B/folder", "projects/B/folder/nested/file.md"],
      selectionAnchorPath: "projects/B/folder/nested/file.md",
    });
  });
});
