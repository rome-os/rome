import { describe, expect, it } from "@rstest/core";
import { MAX_CHANGE_CHARS, changesFromToolUse, classifyPath, groupByFile } from "./changes.js";

const MEMORY = "/home/rome/.rome/default/memory";

describe("changesFromToolUse", () => {
  it("records a Write as the whole file", () => {
    expect(
      changesFromToolUse("Write", { file_path: `${MEMORY}/MEMORY.md`, content: "# Memory" }),
    ).toEqual([
      {
        op: "write",
        path: `${MEMORY}/MEMORY.md`,
        content: "# Memory",
        previous: null,
        truncated: false,
      },
    ]);
  });

  it("records an Edit as the replaced and replacement text", () => {
    expect(
      changesFromToolUse("Edit", { file_path: "/x/MEMORY.md", old_string: "a", new_string: "b" }),
    ).toEqual([
      { op: "edit", path: "/x/MEMORY.md", content: "b", previous: "a", truncated: false },
    ]);
  });

  it("splits a MultiEdit into one change per edit", () => {
    const changes = changesFromToolUse("MultiEdit", {
      file_path: "/x/a.md",
      edits: [
        { old_string: "1", new_string: "one" },
        { old_string: "2", new_string: "two" },
      ],
    });
    expect(changes.map((c) => c.content)).toEqual(["one", "two"]);
  });

  it("ignores tools that do not write files", () => {
    expect(changesFromToolUse("Read", { file_path: "/x/a.md" })).toEqual([]);
    expect(changesFromToolUse("Write", { content: "no path" })).toEqual([]);
    expect(changesFromToolUse("Edit", null)).toEqual([]);
  });

  it("caps a large write and marks it truncated", () => {
    const [change] = changesFromToolUse("Write", {
      file_path: "/x/a.md",
      content: "x".repeat(MAX_CHANGE_CHARS + 10),
    });
    expect(change?.content.length).toBe(MAX_CHANGE_CHARS);
    expect(change?.truncated).toBe(true);
  });
});

describe("classifyPath", () => {
  it("recognizes the daily journal", () => {
    expect(classifyPath(`${MEMORY}/journal/2026/10/06.md`)).toMatchObject({
      area: "journal",
      memoryFile: "journal/2026/10/06.md",
    });
  });

  it("recognizes other memory files by their path under memory/", () => {
    expect(classifyPath(`${MEMORY}/relationship/GUARDIAN.md`)).toMatchObject({
      area: "memory",
      label: "relationship/GUARDIAN.md",
      memoryFile: "relationship/GUARDIAN.md",
    });
    expect(classifyPath("memory/MEMORY.md")).toMatchObject({
      area: "memory",
      memoryFile: "MEMORY.md",
    });
  });

  it("keeps a nested memory/ folder inside the memory path", () => {
    expect(classifyPath(`${MEMORY}/projects/memory/PROJECT.md`).memoryFile).toBe(
      "projects/memory/PROJECT.md",
    );
  });

  it("recognizes a skill and the app that owns it", () => {
    expect(classifyPath("/repo/rome_apps/coding/src/skills/pdf-extract/SKILL.md")).toMatchObject({
      area: "skill",
      label: "coding/src/skills/pdf-extract/SKILL.md",
      skillName: "pdf-extract",
      skillAppId: "coding",
    });
  });

  it("finds the owning app of an installed or custom-source skill", () => {
    expect(
      classifyPath("/p/apps/installed/coding/4f6a/dist/skills/deploy/SKILL.md").skillAppId,
    ).toBe("coding");
    expect(classifyPath("/p/projects/apps/my-notes/src/skills/tidy/SKILL.md").skillAppId).toBe(
      "my-notes",
    );
  });

  it("shortens anything else to its last segments", () => {
    expect(classifyPath("/repo/rome_apps/coding/app.yaml")).toMatchObject({
      area: "other",
      label: "coding/app.yaml",
    });
    expect(classifyPath("/a/b/c/d/e.txt").label).toBe("c/d/e.txt");
  });
});

describe("groupByFile", () => {
  it("groups changes by file in first-touched order", () => {
    const files = groupByFile([
      { op: "edit", path: `${MEMORY}/MEMORY.md`, content: "a", previous: "", truncated: false },
      {
        op: "write",
        path: `${MEMORY}/journal/2026/10/06.md`,
        content: "j",
        previous: null,
        truncated: false,
      },
      { op: "edit", path: `${MEMORY}/MEMORY.md`, content: "b", previous: "", truncated: false },
    ]);
    expect(files.map((f) => [f.area, f.changes.length])).toEqual([
      ["memory", 2],
      ["journal", 1],
    ]);
  });
});
