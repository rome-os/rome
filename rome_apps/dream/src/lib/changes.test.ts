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

// Shapes taken from a Codex skill-review run's trace: the provider reports a
// `fileChange` item as tool `Edit`, with the raw item as the input.
const SKILL =
  "/home/rome/.rome/default/projects/apps/.dream-skill-review-RRj4um/skills/rome-agent-run-audit";

const UPDATE_DIFF =
  "@@ -2,3 +2,3 @@\n name: rome-agent-run-audit\n-description: Diagnose Rome crashes, restarts.\n+description: Diagnose Rome crashes, daemon health-check restarts.\n ---\n@@ -27,2 +27,4 @@\n \n+### Investigate a daemon health-check restart\n+\n ## Recover the execution timeline\n";

const ADD_TEXT =
  "# Measure memory pressure against real coding work\n\nUse read-only observations first.\n";

function fileChange(changes: unknown[]): Record<string, unknown> {
  return { type: "fileChange", id: "exec-e8af79c4", changes, status: "inProgress" };
}

describe("changesFromToolUse on a Codex fileChange", () => {
  it("records an update as one edit per hunk, with the text before and after", () => {
    const changes = changesFromToolUse(
      "Edit",
      fileChange([
        {
          path: `${SKILL}/SKILL.md`,
          kind: { type: "update", move_path: null },
          diff: UPDATE_DIFF,
        },
      ]),
    );
    expect(changes).toEqual([
      {
        op: "edit",
        path: `${SKILL}/SKILL.md`,
        previous: "name: rome-agent-run-audit\ndescription: Diagnose Rome crashes, restarts.\n---",
        content:
          "name: rome-agent-run-audit\ndescription: Diagnose Rome crashes, daemon health-check restarts.\n---",
        truncated: false,
      },
      {
        op: "edit",
        path: `${SKILL}/SKILL.md`,
        previous: "\n## Recover the execution timeline",
        content:
          "\n### Investigate a daemon health-check restart\n\n## Recover the execution timeline",
        truncated: false,
      },
    ]);
  });

  it("records an add as a write of the whole file", () => {
    expect(
      changesFromToolUse(
        "Edit",
        fileChange([
          { path: `${SKILL}/references/memory-pressure.md`, kind: { type: "add" }, diff: ADD_TEXT },
        ]),
      ),
    ).toEqual([
      {
        op: "write",
        path: `${SKILL}/references/memory-pressure.md`,
        content: ADD_TEXT,
        previous: null,
        truncated: false,
      },
    ]);
  });

  it("records every file of a call that touches several, in order", () => {
    const changes = changesFromToolUse(
      "Edit",
      fileChange([
        { path: `${SKILL}/SKILL.md`, kind: { type: "update", move_path: null }, diff: UPDATE_DIFF },
        { path: `${SKILL}/references/memory-pressure.md`, kind: { type: "add" }, diff: ADD_TEXT },
      ]),
    );
    expect(changes.map((c) => [c.op, c.path.split("/").at(-1)])).toEqual([
      ["edit", "SKILL.md"],
      ["edit", "SKILL.md"],
      ["write", "memory-pressure.md"],
    ]);
  });

  it("reads a diff with no hunk header as one hunk, and skips the no-newline marker", () => {
    const [change] = changesFromToolUse(
      "Edit",
      fileChange([
        {
          path: "/x/a.md",
          kind: { type: "update", move_path: null },
          diff: "-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
        },
      ]),
    );
    expect(change).toMatchObject({ op: "edit", previous: "old", content: "new" });
  });

  it("records nothing for a delete, a missing diff, or a malformed entry", () => {
    expect(
      changesFromToolUse(
        "Edit",
        fileChange([
          { path: "/x/a.md", kind: { type: "delete" }, diff: "-gone\n" },
          { path: "/x/b.md", kind: { type: "add" } },
          { kind: { type: "add" }, diff: "no path" },
          null,
        ]),
      ),
    ).toEqual([]);
    expect(changesFromToolUse("Edit", { type: "fileChange", id: "x" })).toEqual([]);
  });

  it("caps a large add and marks it truncated", () => {
    const [change] = changesFromToolUse(
      "Edit",
      fileChange([
        { path: "/x/a.md", kind: { type: "add" }, diff: "x".repeat(MAX_CHANGE_CHARS + 10) },
      ]),
    );
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
