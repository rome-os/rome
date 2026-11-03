import { describe, expect, it } from "@rstest/core";
import type { TraceSegment } from "@rome/api-types/trace-segments";
import { runSegment } from "@/test/fake-turn-stream";
import { describeLatestStep, firstStepStartMs, subagentStartMs } from "./subagent-progress";

describe("describeLatestStep", () => {
  it("is null before the first call", () => {
    expect(describeLatestStep([])).toBeNull();
  });

  it("names the newest call of the newest segment that has one", () => {
    const segments: TraceSegment[] = [
      runSegment("a", [{ tool: "Read", input: { path: "a.ts" } }]),
      runSegment("b", [
        { tool: "Bash", input: { command: "ls" } },
        { tool: "Edit", input: { path: "TraceDrawer.tsx" } },
      ]),
      { kind: "block", id: "t", ordinal: 2, block: { type: "text", content: "hi" } },
    ];
    expect(describeLatestStep(segments)).toBe("Edit TraceDrawer.tsx");
  });

  it("uses the Bash action wording the trace rows use", () => {
    const step = describeLatestStep([
      runSegment("a", [{ tool: "Bash", input: { command: "pnpm test" } }]),
    ]);
    expect(step?.startsWith("Bash ")).toBe(true);
    expect(step).toContain("pnpm test");
  });
});

describe("start times", () => {
  it("takes the earliest timestamped call as the first step's start", () => {
    const segments = [
      runSegment("a", [
        { tool: "Read", input: {}, startedAt: "2026-01-01T00:00:10.000Z" },
        { tool: "Bash", input: {}, startedAt: "2026-01-01T00:00:05.000Z" },
      ]),
    ];
    expect(firstStepStartMs(segments)).toBe(Date.parse("2026-01-01T00:00:05.000Z"));
    expect(firstStepStartMs([runSegment("a", [{ tool: "Read", input: {} }])])).toBeNull();
  });

  it("reads a subagent's start from the parent's subagent_start block", () => {
    const parent: TraceSegment[] = [
      {
        kind: "run",
        id: "p",
        ordinal: 0,
        count: 1,
        app: { id: "x", name: "X", iconUrl: "/i" },
        blocks: [
          {
            type: "subagent_start",
            toolUseId: "tu-1",
            agentName: "planning",
            input: {},
            sessionId: "s",
            turnId: "t",
            startedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ];
    expect(subagentStartMs(parent, "tu-1")).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(subagentStartMs(parent, "other")).toBeNull();
    expect(subagentStartMs(undefined, "tu-1")).toBeNull();
  });
});
