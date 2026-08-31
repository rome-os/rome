import { describe, expect, it } from "@rstest/core";

import {
  dataTransferHasFiles,
  extractFilesFromClipboard,
  extractFilesFromDataTransfer,
} from "@/lib/clipboard-files";

describe("clipboard file helpers", () => {
  it("extracts files exposed directly on clipboardData.files", () => {
    const file = new File(["hello"], "note.txt", { type: "text/plain" });

    expect(extractFilesFromClipboard({ files: [file], items: [] })).toEqual([file]);
  });

  it("falls back to file items when clipboardData.files is empty", () => {
    const image = new File(["png"], "pasted-image.png", { type: "image/png" });

    expect(
      extractFilesFromClipboard({
        files: [],
        items: [
          { kind: "string" },
          { kind: "file", getAsFile: () => image },
          { kind: "file", getAsFile: () => null },
        ],
      }),
    ).toEqual([image]);
  });

  it("assigns synthetic names to nameless pasted files", () => {
    const image = new File(["png"], "", { type: "image/png", lastModified: 42 });
    const plainText = new File(["hello"], "   ", { type: "text/plain", lastModified: 43 });
    const unknown = new File(["data"], "", { type: "", lastModified: 44 });

    const files = extractFilesFromClipboard({
      files: [image, plainText, unknown],
    });

    expect(files.map((file) => file.name)).toEqual([
      "pasted-file-1.png",
      "pasted-file-2.txt",
      "pasted-file-3.bin",
    ]);
    expect(files.map((file) => file.type)).toEqual(["image/png", "text/plain", ""]);
    expect(files.map((file) => file.lastModified)).toEqual([42, 43, 44]);
  });

  it("detects files from types, files, or items", () => {
    const file = new File(["data"], "data.csv", { type: "text/csv" });

    expect(dataTransferHasFiles({ types: ["Files"] })).toBe(true);
    expect(dataTransferHasFiles({ files: [file] })).toBe(true);
    expect(dataTransferHasFiles({ items: [{ kind: "file" }] })).toBe(true);
    expect(dataTransferHasFiles({ types: ["text/plain"], items: [{ kind: "string" }] })).toBe(
      false,
    );
  });

  it("extracts dropped files from dataTransfer.files", () => {
    const file = new File(["hello"], "note.txt", { type: "text/plain" });

    expect(extractFilesFromDataTransfer({ files: [file], items: [] })).toEqual([file]);
  });

  it("falls back to dataTransfer.items when dropped files are not directly exposed", () => {
    const file = new File(["hello"], "note.txt", { type: "text/plain" });

    expect(
      extractFilesFromDataTransfer({
        files: [],
        items: [
          { kind: "string" },
          { kind: "file", getAsFile: () => file },
          { kind: "file", getAsFile: () => null },
        ],
      }),
    ).toEqual([file]);
  });
});
