import { describe, expect, it } from "@rstest/core";
import { outputsInMessage, outputsInTrace } from "./trace-outputs.js";

const ASSET = "/api/assets/0123456789abcdef0123456789abcdef.png";

describe("outputsInTrace", () => {
  it("finds a file a Write call wrote, once its result succeeds", () => {
    const found = outputsInTrace([
      { type: "tool_use", id: "w1", tool: "Write", input: { file_path: "/p/a/notes.md" } },
      { type: "tool_result", toolUseId: "w1", tool: "Write", output: "ok" },
    ]);
    expect(found).toEqual([
      {
        sourceKey: "w1",
        kind: "written",
        path: "/p/a/notes.md",
        sourcePath: null,
        name: "notes.md",
        mimeType: "text/markdown",
      },
    ]);
  });

  it("finds nothing for a failed write, a read or a call with no result yet", () => {
    expect(
      outputsInTrace([
        { type: "tool_use", id: "w1", tool: "Edit", input: { file_path: "/p/a.ts" } },
        { type: "tool_result", toolUseId: "w1", tool: "Edit", isError: true, output: "no" },
        { type: "tool_use", id: "r1", tool: "Read", input: { file_path: "/p/b.ts" } },
        { type: "tool_result", toolUseId: "r1", tool: "Read", output: "text" },
        { type: "tool_use", id: "w2", tool: "Write", input: { file_path: "/p/c.ts" } },
      ]),
    ).toEqual([]);
  });

  it("finds each file a Codex change touched", () => {
    const found = outputsInTrace([
      {
        type: "tool_use",
        id: "c1",
        tool: "Edit",
        input: { type: "fileChange", changes: [{ path: "/p/one.ts" }, { path: "/p/two.ts" }] },
      },
      { type: "tool_result", toolUseId: "c1", tool: "Edit", output: {} },
    ]);
    expect(found.map((output) => [output.sourceKey, output.path])).toEqual([
      ["c1#0", "/p/one.ts"],
      ["c1#1", "/p/two.ts"],
    ]);
  });

  it("looks up a call an earlier stretch of the trace stored", () => {
    const found = outputsInTrace(
      [{ type: "tool_result", toolUseId: "w1", tool: "Write", output: "ok" }],
      (id) =>
        id === "w1"
          ? { type: "tool_use", id: "w1", tool: "Write", input: { file_path: "/p/x.txt" } }
          : null,
    );
    expect(found.map((output) => output.path)).toEqual(["/p/x.txt"]);
  });

  it("finds the copy core:show_file stored, named after the file it copied", () => {
    const found = outputsInTrace([
      {
        type: "tool_use",
        id: "s1",
        tool: "execute_action",
        input: { action_name: "core:show_file", json_args: { path: "/p/chart.png" } },
      },
      {
        type: "tool_result",
        toolUseId: "s1",
        tool: "execute_action",
        output: JSON.stringify({ url: ASSET, markdown: `![chart.png](${ASSET})` }),
      },
    ]);
    expect(found).toEqual([
      {
        sourceKey: "s1",
        kind: "shown",
        path: ASSET,
        sourcePath: "/p/chart.png",
        name: "chart.png",
        mimeType: "image/png",
      },
    ]);
  });

  it("finds nothing for a show_file call that was refused, or another action", () => {
    expect(
      outputsInTrace([
        {
          type: "tool_use",
          id: "s1",
          tool: "execute_action",
          input: { action_name: "core:show_file", json_args: { path: "/etc/passwd" } },
        },
        {
          type: "tool_result",
          toolUseId: "s1",
          tool: "execute_action",
          output: { status: "error", error: "File is outside the folders chat can show" },
        },
        {
          type: "tool_use",
          id: "o1",
          tool: "execute_action",
          input: { action_name: "core:other", json_args: {} },
        },
        { type: "tool_result", toolUseId: "o1", tool: "execute_action", output: ASSET },
      ]),
    ).toEqual([]);
  });
});

describe("outputsInMessage", () => {
  it("finds each asset an agent message links, named by a file-like label", () => {
    const content = JSON.stringify([
      { type: "text", content: `Here: ![report.pdf](${ASSET}) and again [the chart](${ASSET})` },
    ]);
    expect(outputsInMessage("m1", content)).toEqual([
      {
        sourceKey: `link:m1:${ASSET}`,
        kind: "shown",
        path: ASSET,
        sourcePath: null,
        name: "report.pdf",
        mimeType: "image/png",
      },
    ]);
  });

  it("names an asset by its stored name when the label is prose", () => {
    const content = JSON.stringify([{ type: "text", content: `[the chart](${ASSET})` }]);
    expect(outputsInMessage("m1", content)[0]?.name).toBe("0123456789abcdef0123456789abcdef.png");
  });
});
