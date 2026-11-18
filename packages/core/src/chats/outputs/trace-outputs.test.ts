import { describe, expect, it } from "@rstest/core";
import { outputsInMessage, outputsInReply, outputsInTrace } from "./trace-outputs.js";

const FILES = new Set(["/home/p/test/hello.txt", "/home/p/test/my notes.md", "/tmp/out.csv"]);
const SCOPE = {
  projectsRoot: "/home/p",
  isFile: (path: string) => FILES.has(path),
  traceId: "tr1",
};

/** A Codex command run, as the trace stores its call and result. */
function codexRun(
  id: string,
  command: string,
  result: { exitCode: number | null; status: string },
) {
  const run = { type: "commandExecution", id, command, cwd: "/home/p/test" };
  return [
    { type: "tool_use", id, tool: "Bash", input: { ...run, status: "inProgress", exitCode: null } },
    { type: "tool_result", toolUseId: id, tool: "Bash", output: { ...run, ...result } },
  ];
}

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

describe("outputsInTrace, for shell commands and replies", () => {
  it("finds a file a Codex command wrote, resolved against its folder, once it succeeds", () => {
    const found = outputsInTrace(
      codexRun("c1", `/usr/bin/bash -lc "printf 'hi' > hello.txt && cat hello.txt"`, {
        exitCode: 0,
        status: "completed",
      }),
      undefined,
      SCOPE,
    );
    expect(found).toEqual([
      {
        sourceKey: "c1#sh:/home/p/test/hello.txt",
        kind: "written",
        path: "/home/p/test/hello.txt",
        sourcePath: null,
        name: "hello.txt",
        mimeType: "text/plain",
      },
    ]);
  });

  it("finds nothing for a failed command, a file not there, or without a way to check files", () => {
    const failed = codexRun("c1", "echo hi > hello.txt", { exitCode: 1, status: "failed" });
    const gone = codexRun("c2", "echo hi > gone.txt", { exitCode: 0, status: "completed" });
    expect(outputsInTrace([...failed, ...gone], undefined, SCOPE)).toEqual([]);
    const ok = codexRun("c3", "echo hi > hello.txt", { exitCode: 0, status: "completed" });
    expect(outputsInTrace(ok)).toEqual([]);
  });

  it("finds a Claude Code shell write only by an absolute path, as its call names no folder", () => {
    const found = outputsInTrace(
      [
        {
          type: "tool_use",
          id: "b1",
          tool: "Bash",
          input: { command: "date > when.txt; cp a /tmp/out.csv" },
        },
        { type: "tool_result", toolUseId: "b1", tool: "Bash", output: "" },
      ],
      undefined,
      SCOPE,
    );
    expect(found.map((output) => output.path)).toEqual(["/tmp/out.csv"]);
  });

  it("finds the local files a turn's reply links", () => {
    const reply =
      "已生成 [hello.txt](</projects/test/hello.txt>)，see [notes](/projects/test/my%20notes.md), " +
      "[web](https://example.com/a.txt), [asset](/api/assets/x.png), [gone](/projects/test/gone.txt), " +
      "[escape](/projects/../etc/passwd) and [abs](/tmp/out.csv).";
    const found = outputsInTrace([{ type: "result", content: reply }], undefined, SCOPE);
    expect(found.map((output) => [output.sourceKey, output.name])).toEqual([
      ["reply:tr1:/home/p/test/hello.txt", "hello.txt"],
      ["reply:tr1:/home/p/test/my notes.md", "my notes.md"],
      ["reply:tr1:/tmp/out.csv", "out.csv"],
    ]);
    expect(
      outputsInReply("tr1", "[a](/projects/test/hello.txt) [b](/projects/test/hello.txt)", SCOPE),
    ).toHaveLength(1);
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
