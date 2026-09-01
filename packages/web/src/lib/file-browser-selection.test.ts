import { describe, expect, it } from "@rstest/core";
import {
  getNextBrowserSelection,
  shouldPreserveDisplayedFileContent,
} from "./file-browser-selection";

const orderedPaths = [
  "projects/app",
  "projects/app/src",
  "projects/app/src/index.ts",
  "projects/app/test.ts",
  "projects/notes.md",
];

describe("getNextBrowserSelection", () => {
  it("replaces selection on a plain click", () => {
    expect(
      getNextBrowserSelection({
        additive: false,
        anchorPath: "projects/app",
        orderedPaths,
        range: false,
        selectedPaths: ["projects/app"],
        targetPath: "projects/notes.md",
      }),
    ).toEqual({
      anchorPath: "projects/notes.md",
      selectedPaths: ["projects/notes.md"],
    });
  });

  it("range-selects from the anchor on shift click", () => {
    expect(
      getNextBrowserSelection({
        additive: false,
        anchorPath: "projects/app/src",
        orderedPaths,
        range: true,
        selectedPaths: ["projects/app/src"],
        targetPath: "projects/app/test.ts",
      }),
    ).toEqual({
      anchorPath: "projects/app/src",
      selectedPaths: ["projects/app/src", "projects/app/src/index.ts", "projects/app/test.ts"],
    });
  });

  it("toggles a path on command or control click", () => {
    expect(
      getNextBrowserSelection({
        additive: true,
        anchorPath: "projects/app",
        orderedPaths,
        range: false,
        selectedPaths: ["projects/app", "projects/notes.md"],
        targetPath: "projects/app",
      }),
    ).toEqual({
      anchorPath: "projects/app",
      selectedPaths: ["projects/notes.md"],
    });
  });

  it("keeps additive selection in tree order", () => {
    expect(
      getNextBrowserSelection({
        additive: true,
        anchorPath: "projects/notes.md",
        orderedPaths,
        range: false,
        selectedPaths: ["projects/notes.md"],
        targetPath: "projects/app/src/index.ts",
      }),
    ).toEqual({
      anchorPath: "projects/app/src/index.ts",
      selectedPaths: ["projects/app/src/index.ts", "projects/notes.md"],
    });
  });
});

describe("shouldPreserveDisplayedFileContent", () => {
  it("preserves only when the same file is already displayed", () => {
    expect(
      shouldPreserveDisplayedFileContent({
        currentPath: "projects/demo/brief.docx",
        displayedFilePath: "projects/demo/brief.docx",
        requestedPath: "projects/demo/brief.docx",
      }),
    ).toBe(true);
  });

  it("does not preserve while the route load has only selected the path", () => {
    expect(
      shouldPreserveDisplayedFileContent({
        currentPath: "projects/demo/brief.docx",
        displayedFilePath: null,
        requestedPath: "projects/demo/brief.docx",
      }),
    ).toBe(false);
  });

  it("does not preserve stale displayed content from another file", () => {
    expect(
      shouldPreserveDisplayedFileContent({
        currentPath: "projects/demo/brief.docx",
        displayedFilePath: "projects/demo/old.docx",
        requestedPath: "projects/demo/brief.docx",
      }),
    ).toBe(false);
  });
});
