import { describe, expect, it } from "@rstest/core";
import {
  MAX_CHANGE_CHARS,
  fileChangesFromToolUse,
  classifyPath,
  groupByFile,
  isSecretFile,
} from "./changes.js";
import { lineDiff } from "../web/lib/diff.js";

const MEMORY = "/home/rome/.rome/default/memory";
const changesFromToolUse = (...args: Parameters<typeof fileChangesFromToolUse>) =>
  fileChangesFromToolUse(...args).changes;
const pathsFromToolUse = (...args: Parameters<typeof fileChangesFromToolUse>) =>
  fileChangesFromToolUse(...args).paths;

describe("isSecretFile", () => {
  it("recognizes secret files without reading them", () => {
    expect(isSecretFile("/apps/notes/.env")).toBe(true);
    expect(isSecretFile("C:\\apps\\notes\\.env.local")).toBe(true);
    expect(isSecretFile("C:\\apps\\notes\\.env.example")).toBe(false);
  });
});

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

describe("pathsFromToolUse", () => {
  it("keeps deleted and renamed paths for attribution", () => {
    expect(
      pathsFromToolUse("Edit", {
        type: "fileChange",
        changes: [
          { path: "/apps/notes/src/gone.ts", kind: { type: "delete" }, diff: "-gone\n" },
          {
            path: "/apps/notes/src/old.ts",
            kind: { type: "update", move_path: "/apps/notes/src/new.ts" },
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
        ],
      }),
    ).toEqual(["/apps/notes/src/gone.ts", "/apps/notes/src/old.ts", "/apps/notes/src/new.ts"]);
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
  it("records an update as one edit per run of changed lines, with the text around it", () => {
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

  it("splits a hunk that changes two places so unchanged lines between them stay context", () => {
    const changes = changesFromToolUse(
      "Edit",
      fileChange([
        {
          path: "/x/a.md",
          kind: { type: "update", move_path: null },
          diff: "@@ -1,7 +1,7 @@\n head\n-old first\n+new first\n same\n also same\n-old second\n+new second\n tail\n",
        },
      ]),
    );
    expect(changes.map((c) => [c.previous, c.content])).toEqual([
      ["head\nold first\nsame\nalso same", "head\nnew first\nsame\nalso same"],
      ["same\nalso same\nold second\ntail", "same\nalso same\nnew second\ntail"],
    ]);
    // What the page draws from each change: the shared lines read as context.
    const drawn = changes.map((c) => lineDiff(c.previous ?? "", c.content).map((l) => l.type));
    expect(drawn).toEqual([
      ["context", "removed", "added", "context", "context"],
      ["context", "context", "removed", "added", "context"],
    ]);
  });

  it("records nothing for a hunk with no changed lines", () => {
    expect(
      changesFromToolUse(
        "Edit",
        fileChange([
          {
            path: "/x/a.md",
            kind: { type: "update", move_path: null },
            diff: "@@ -1,2 +1,2 @@\n a\n b\n",
          },
        ]),
      ),
    ).toEqual([]);
  });

  it("records an update that renames the file under the new path", () => {
    const [change] = changesFromToolUse(
      "Edit",
      fileChange([
        {
          path: `${SKILL}/references/old.md`,
          kind: { type: "update", move_path: `${SKILL}/references/new.md` },
          diff: "@@ -1 +1 @@\n-a\n+b\n",
        },
      ]),
    );
    expect(change).toMatchObject({ op: "edit", path: `${SKILL}/references/new.md` });
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
  it("keeps an app's own memory folder out of the guardian's memory", () => {
    expect(classifyPath("/p/projects/apps/notes/src/memory/store.ts")).toMatchObject({
      area: "other",
      memoryFile: null,
    });
    expect(classifyPath(`${MEMORY}/topics/x.md`)).toMatchObject({ area: "memory" });
  });

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

  it("prefers unknown provenance when a file has an unattributed change", () => {
    const path = "/apps/notes/src/index.ts";
    const files = groupByFile([
      {
        op: "edit",
        path,
        content: "practice",
        previous: "before",
        truncated: false,
        attribution: "practice",
      },
      {
        op: "edit",
        path,
        content: "concurrent",
        previous: "practice",
        truncated: false,
        attribution: "unattributed",
      },
    ]);

    expect(files).toMatchObject([{ path, attribution: "unattributed", changes: [{}, {}] }]);
  });
});
