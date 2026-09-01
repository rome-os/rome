import { describe, expect, it } from "@rstest/core";
import { getUploadEntriesFromFileList } from "./file-browser-upload";

function fileWithRelativePath(name: string, relativePath: string): File {
  const file = new File(["content"], name);
  Object.defineProperty(file, "webkitRelativePath", {
    configurable: true,
    value: relativePath,
  });
  return file;
}

describe("file browser upload helpers", () => {
  it("preserves folder picker relative paths", () => {
    const entries = getUploadEntriesFromFileList([
      fileWithRelativePath("index.ts", "demo/src/index.ts"),
      fileWithRelativePath("README.md", "demo/README.md"),
    ]);

    expect(entries.map(({ relativePath }) => relativePath)).toEqual([
      "demo/src/index.ts",
      "demo/README.md",
    ]);
  });

  it("falls back to the file name for regular file uploads", () => {
    const entries = getUploadEntriesFromFileList([new File(["hello"], "note.txt")]);

    expect(entries).toMatchObject([{ relativePath: "note.txt" }]);
  });
});
