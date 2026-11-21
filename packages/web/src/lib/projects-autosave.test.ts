import { describe, expect, it } from "@rstest/core";
import { getProjectsAutoSavePolicy, LARGE_TEXT_FILE_BYTES } from "./projects-autosave";

const file = (over: Partial<Parameters<typeof getProjectsAutoSavePolicy>[0]> = {}) => ({
  editable: true,
  kind: "text",
  path: "projects/demo/notes.md",
  size: 10,
  ...over,
});

describe("getProjectsAutoSavePolicy", () => {
  it("saves a Markdown or text file after two seconds, without a commit", () => {
    for (const path of ["projects/a/x.md", "projects/a/x.MDX", "projects/a/x.txt"]) {
      expect(getProjectsAutoSavePolicy(file({ path }))).toEqual({ commit: false, delayMs: 2000 });
    }
  });

  it("waits five seconds on a file over 1 MB, and not on one at exactly 1 MB", () => {
    expect(getProjectsAutoSavePolicy(file({ size: LARGE_TEXT_FILE_BYTES }))?.delayMs).toBe(2000);
    expect(getProjectsAutoSavePolicy(file({ size: LARGE_TEXT_FILE_BYTES + 1 }))?.delayMs).toBe(
      5000,
    );
  });

  it("leaves other text types, read-only files and binaries to a hand save", () => {
    expect(getProjectsAutoSavePolicy(file({ path: "projects/a/x.ts" }))).toBeNull();
    expect(getProjectsAutoSavePolicy(file({ editable: false }))).toBeNull();
    expect(getProjectsAutoSavePolicy(file({ kind: "binary" }))).toBeNull();
  });
});
