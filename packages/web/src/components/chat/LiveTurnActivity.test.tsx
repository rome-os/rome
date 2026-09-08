// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import type { TraceSegment, TraceSnapshot } from "@rome/api-types/trace-segments";
import { startStream, updateAssistantText, updateSnapshot } from "@/hooks/use-streaming-sessions";
import { LiveTurnActivity } from "./LiveTurnActivity";
import "@/i18n";

afterEach(cleanup);

const thinking = (ordinal: number, content: string): TraceSegment => ({
  kind: "block",
  id: `thinking-${ordinal}`,
  ordinal,
  block: { type: "thinking", content },
});
const snapshot = (...segments: TraceSegment[]): TraceSnapshot => ({
  segments,
  summary: { distinctApps: [], totalSteps: 0, invocationCounts: {} },
});

describe("transient turn activity", () => {
  it("replaces thinking, dismisses it on text, and does not revive it on a boundary or summary update", () => {
    let state = startStream(new Map(), "session", "turn");
    const view = () => {
      const stream = state.get("session")!;
      return <LiveTurnActivity {...stream} hasText={!!stream.assistantText} />;
    };
    state = updateSnapshot(
      state,
      "session",
      "turn",
      snapshot(thinking(0, "**Planning shell commands**")),
    );
    const { rerender } = render(view());
    expect(screen.getByRole("status").textContent).toBe("Planning shell commands");

    const next = snapshot(
      thinking(0, "**Planning shell commands**"),
      thinking(1, "Checking results"),
    );
    state = updateSnapshot(state, "session", "turn", next);
    rerender(view());
    expect(screen.queryByText("Planning shell commands")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("Checking results")).toBeTruthy();

    state = updateAssistantText(state, "session", "turn", 0, "The results");
    rerender(view());
    expect(screen.queryByRole("status")).toBeNull();
    state = updateAssistantText(state, "session", "turn", 1, "");
    state = updateSnapshot(state, "session", "turn", {
      ...next,
      summary: { ...next.summary, totalSteps: 2 },
    });
    rerender(view());
    expect(screen.queryByText("Checking results")).toBeNull();

    state = updateSnapshot(
      state,
      "session",
      "turn",
      snapshot(...next.segments, thinking(2, "Verifying output")),
    );
    state = updateAssistantText(state, "session", "turn", 2, "");
    rerender(view());
    expect(screen.getByText("Verifying output")).toBeTruthy();
  });

  it("keeps parallel tools active until every paired invocation completes", () => {
    const run: TraceSegment = {
      kind: "run",
      id: "run",
      ordinal: 1,
      count: 2,
      app: { id: "system", name: "System", iconUrl: "/app-icon.svg" },
      blocks: [
        { type: "tool_use", tool: "shell", id: "a", input: {} },
        { type: "tool_use", tool: "shell", id: "b", input: {} },
        { type: "tool_result", tool: "shell", toolUseId: "b", output: "ok" },
      ],
    };
    const { rerender } = render(<LiveTurnActivity snapshot={snapshot(run)} hasText={false} />);
    expect(screen.getByRole("status").textContent).toContain("System");
    const finished = {
      ...run,
      blocks: [
        run.blocks[0],
        { type: "tool_result" as const, tool: "shell", toolUseId: "a", output: "ok" },
        ...run.blocks.slice(1),
      ],
    };
    rerender(<LiveTurnActivity snapshot={snapshot(finished)} hasText={false} />);
    expect(screen.getByRole("status").textContent).not.toContain("System");
    const otherApp = {
      ...finished,
      id: "other",
      ordinal: 2,
      app: { ...run.app, id: "other", name: "Other app" },
    };
    rerender(<LiveTurnActivity snapshot={snapshot(run, otherApp)} hasText={false} />);
    expect(screen.getByRole("status").textContent).toContain("System");
    rerender(<LiveTurnActivity snapshot={snapshot(finished)} textThroughOrdinal={1} hasText />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("clears progress for completed, stopped, and failed turns", () => {
    const trace = snapshot(thinking(0, "Still working"));
    for (const turnStatus of ["completed", "interrupted", "error"] as const) {
      const { unmount } = render(
        <LiveTurnActivity
          snapshot={{ ...trace, summary: { ...trace.summary, turnStatus } }}
          hasText={false}
        />,
      );
      expect(screen.queryByRole("status")).toBeNull();
      unmount();
    }
  });
});
