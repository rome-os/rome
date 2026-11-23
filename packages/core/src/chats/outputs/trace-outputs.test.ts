import { describe, expect, it } from "@rstest/core";
import {
  outputsInMessage,
  outputsInReply,
  outputsInTrace,
  routeProjectLinks,
} from "./trace-outputs.js";

const FILES = new Set([
  "/home/p/test/hello.txt",
  "/home/p/test/my notes.md",
  "/home/mem/notes.md",
  "/tmp/out.csv",
  "/home/assets/upload.pdf",
]);
/** When each file changed; one not named here changed at noon. */
const CHANGED = new Map([["/home/p/test/old.md", Date.parse("2026-11-01T00:00:00Z")]]);
FILES.add("/home/p/test/old.md");
const NOON = Date.parse("2026-11-17T12:00:00Z");
const SCOPE = {
  projectsRoot: "/home/p",
  roots: ["/home/p", "/home/mem"],
  changedAt: (path: string) => (FILES.has(path) ? (CHANGED.get(path) ?? NOON) : null),
};
/** A trace's context, without reading shell commands or replies. */
const T = { traceId: "tr1" };
/** A trace's context that reads them. */
const CTX = { traceId: "tr1", files: SCOPE };

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
    const found = outputsInTrace(
      [
        { type: "tool_use", id: "w1", tool: "Write", input: { file_path: "/p/a/notes.md" } },
        { type: "tool_result", toolUseId: "w1", tool: "Write", output: "ok" },
      ],
      T,
    );
    expect(found).toEqual([
      {
        sourceKey: "tr1:w1",
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
      outputsInTrace(
        [
          { type: "tool_use", id: "w1", tool: "Edit", input: { file_path: "/p/a.ts" } },
          { type: "tool_result", toolUseId: "w1", tool: "Edit", isError: true, output: "no" },
          { type: "tool_use", id: "r1", tool: "Read", input: { file_path: "/p/b.ts" } },
          { type: "tool_result", toolUseId: "r1", tool: "Read", output: "text" },
          { type: "tool_use", id: "w2", tool: "Write", input: { file_path: "/p/c.ts" } },
        ],
        T,
      ),
    ).toEqual([]);
  });

  it("finds each file a Codex change touched", () => {
    const found = outputsInTrace(
      [
        {
          type: "tool_use",
          id: "c1",
          tool: "Edit",
          input: { type: "fileChange", changes: [{ path: "/p/one.ts" }, { path: "/p/two.ts" }] },
        },
        { type: "tool_result", toolUseId: "c1", tool: "Edit", output: {} },
      ],
      T,
    );
    expect(found.map((output) => [output.sourceKey, output.path])).toEqual([
      ["tr1:c1#0", "/p/one.ts"],
      ["tr1:c1#1", "/p/two.ts"],
    ]);
  });

  it("looks up a call an earlier stretch of the trace stored", () => {
    const found = outputsInTrace(
      [{ type: "tool_result", toolUseId: "w1", tool: "Write", output: "ok" }],
      {
        traceId: "tr1",
        findUse: (id) =>
          id === "w1"
            ? { type: "tool_use", id: "w1", tool: "Write", input: { file_path: "/p/x.txt" } }
            : null,
      },
    );
    expect(found.map((output) => output.path)).toEqual(["/p/x.txt"]);
  });

  it("finds the copy core:show_file stored, named after the file it copied", () => {
    const found = outputsInTrace(
      [
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
      ],
      T,
    );
    expect(found).toEqual([
      {
        sourceKey: "tr1:s1",
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
      outputsInTrace(
        [
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
        ],
        T,
      ),
    ).toEqual([]);
  });
});

describe("outputsInTrace, across traces", () => {
  it("keeps a call id a later turn reuses apart, as Codex numbers each turn's calls afresh", () => {
    const edit = (path: string) => [
      { type: "tool_use", id: "item_0", tool: "Edit", input: { file_path: path } },
      { type: "tool_result", toolUseId: "item_0", tool: "Edit", output: "ok" },
    ];
    const first = outputsInTrace(edit("/p/a.md"), { traceId: "turn-1" });
    const second = outputsInTrace(edit("/p/b.md"), { traceId: "turn-2" });
    expect(first[0].sourceKey).not.toBe(second[0].sourceKey);
    // The same trace read again gives the same key, so a replay records nothing new.
    expect(outputsInTrace(edit("/p/a.md"), { traceId: "turn-1" })[0].sourceKey).toBe(
      first[0].sourceKey,
    );
  });
});

describe("outputsInTrace, for shell commands and replies", () => {
  it("finds a file a Codex command wrote, resolved against its folder, once it succeeds", () => {
    const found = outputsInTrace(
      codexRun("c1", `/usr/bin/bash -lc "printf 'hi' > hello.txt && cat hello.txt"`, {
        exitCode: 0,
        status: "completed",
      }),
      CTX,
    );
    expect(found).toEqual([
      {
        sourceKey: "tr1:c1#sh:/home/p/test/hello.txt",
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
    expect(outputsInTrace([...failed, ...gone], CTX)).toEqual([]);
    const ok = codexRun("c3", "echo hi > hello.txt", { exitCode: 0, status: "completed" });
    expect(outputsInTrace(ok, T)).toEqual([]);
  });

  it("finds a Claude Code shell write only by an absolute path in a folder the agent produces in", () => {
    const found = outputsInTrace(
      [
        {
          type: "tool_use",
          id: "b1",
          tool: "Bash",
          input: { command: "date > when.txt; cp a /tmp/out.csv; cp b /home/mem/notes.md" },
        },
        { type: "tool_result", toolUseId: "b1", tool: "Bash", output: "" },
      ],
      CTX,
    );
    expect(found.map((output) => output.path)).toEqual(["/home/mem/notes.md"]);
  });

  it("finds the local files a turn's reply links", () => {
    const reply =
      "已生成 [hello.txt](</projects/test/hello.txt>)，see [notes](/projects/test/my%20notes.md), " +
      "[web](https://example.com/a.txt), [asset](/api/assets/x.png), [gone](/projects/test/gone.txt), " +
      "[escape](/projects/../etc/passwd), [log](/tmp/out.csv), [upload](/home/assets/upload.pdf) " +
      "and [memory](/home/mem/notes.md).";
    const found = outputsInTrace([{ type: "result", content: reply }], CTX);
    expect(found.map((output) => [output.sourceKey, output.name])).toEqual([
      ["reply:tr1:/home/p/test/hello.txt", "hello.txt"],
      ["reply:tr1:/home/p/test/my notes.md", "my notes.md"],
      ["reply:tr1:/home/mem/notes.md", "notes.md"],
    ]);
    expect(
      outputsInReply("tr1", "[a](/projects/test/hello.txt) [b](/projects/test/hello.txt)", SCOPE),
    ).toHaveLength(1);
  });

  it("finds a linked file whose path has spaces and no angle brackets", () => {
    const reply =
      'See [notes](/projects/test/my notes.md) and [hi](/home/p/test/hello.txt "Hello").';
    const found = outputsInTrace([{ type: "result", content: reply }], CTX);
    expect(found.map((output) => output.path)).toEqual([
      "/home/p/test/my notes.md",
      "/home/p/test/hello.txt",
    ]);
  });

  it("leaves out a file the reply only cites, unchanged since the turn began", () => {
    const reply =
      "I wrote [hello.txt](/projects/test/hello.txt) after reading [old.md](/projects/test/old.md).";
    const found = outputsInTrace([{ type: "result", content: reply }], {
      ...CTX,
      startedAt: new Date(NOON - 60_000),
    });
    expect(found.map((output) => output.name)).toEqual(["hello.txt"]);
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

describe("routeProjectLinks", () => {
  const ROOT = "/home/p";

  it("points an absolute path or file URL under the projects folder at its route", () => {
    expect(routeProjectLinks("Done: [report](/home/p/test/report.md).", ROOT)).toBe(
      "Done: [report](/projects/test/report.md).",
    );
    expect(routeProjectLinks("[a](</home/p/test/my notes.md>)", ROOT)).toBe(
      "[a](</projects/test/my notes.md>)",
    );
    expect(routeProjectLinks("[a](/home/p/test/my notes.md)", ROOT)).toBe(
      "[a](</projects/test/my notes.md>)",
    );
    expect(routeProjectLinks("[a](file:///home/p/test/%E6%8A%A5%E5%91%8A.md)", ROOT)).toBe(
      "[a](/projects/test/报告.md)",
    );
    expect(routeProjectLinks('![chart](/home/p/test/c.png "Chart")', ROOT)).toBe(
      '![chart](/projects/test/c.png "Chart")',
    );
  });

  it("makes a bare file URL under the projects folder a link named after its file", () => {
    expect(routeProjectLinks("Saved to file:///home/p/test/out.csv now", ROOT)).toBe(
      "Saved to [out.csv](/projects/test/out.csv) now",
    );
  });

  it("keeps punctuation and emphasis around a bare file URL outside its link", () => {
    const at = "file:///home/p/test/out.csv";
    const link = "[out.csv](/projects/test/out.csv)";
    expect(routeProjectLinks(`Saved to ${at}.`, ROOT)).toBe(`Saved to ${link}.`);
    expect(routeProjectLinks(`见 ${at}。`, ROOT)).toBe(`见 ${link}。`);
    expect(routeProjectLinks(`${at}, ${at}`, ROOT)).toBe(`${link}, ${link}`);
    expect(routeProjectLinks(`**${at}**`, ROOT)).toBe(`**${link}**`);
    // A file URL that labels a link stays its label.
    expect(routeProjectLinks(`[${at}](${at})`, ROOT)).toBe(`[${at}](/projects/test/out.csv)`);
  });

  it("reads a link's title and the parentheses in its path", () => {
    expect(routeProjectLinks("[a](/home/p/x.md 'Title')", ROOT)).toBe(
      "[a](/projects/x.md 'Title')",
    );
    expect(routeProjectLinks("[a](/home/p/x.md (Title))", ROOT)).toBe(
      "[a](/projects/x.md (Title))",
    );
    expect(routeProjectLinks("[r](/home/p/test/report(final).pdf)", ROOT)).toBe(
      "[r](</projects/test/report(final).pdf>)",
    );
  });

  it("leaves indented code and code inside quotes and lists as written", () => {
    const kept = [
      'Config:\n\n    url = "file:///home/p/test/report.csv"\n    [r](/home/p/r.pdf)\n',
      "> Run:\n> ```\n> cat file:///home/p/a.md\n> ```\n",
      "- Step\n\n      [r](/home/p/r.pdf)\n",
      "<div>[r](/home/p/r.pdf)</div>\n",
    ];
    for (const text of kept) expect(routeProjectLinks(text, ROOT)).toBe(text);
    expect(routeProjectLinks("    code\n\nSee [r](/home/p/r.pdf).", ROOT)).toBe(
      "    code\n\nSee [r](/projects/r.pdf).",
    );
  });

  it("leaves code, routes, web links and paths outside the projects folder as written", () => {
    const kept = [
      "Run `cat /home/p/test/a.md` or `[x](/home/p/a.md)`.",
      "```\n[x](/home/p/a.md) file:///home/p/a.md\n```",
      "[a](/projects/test/a.md) [b](https://example.com/home/p/a.md) [c](/apps/notes)",
      "[log](/tmp/out.csv) file:///etc/passwd [up](/home/p/../etc/passwd) [api](/api/assets/x.png)",
    ];
    for (const text of kept) expect(routeProjectLinks(text, ROOT)).toBe(text);
    expect(routeProjectLinks("`a` then [b](/home/p/b.md)", ROOT)).toBe(
      "`a` then [b](/projects/b.md)",
    );
  });
});
