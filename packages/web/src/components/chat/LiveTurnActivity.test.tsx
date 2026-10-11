// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { TraceSegment, TraceSnapshot } from "@rome/api-types/trace-segments";
import { startStream, updateAssistantText, updateSnapshot } from "@/hooks/use-streaming-sessions";
import { LiveTurnActivity } from "./LiveTurnActivity";
import "@/i18n";

afterEach(() => {
  cleanup();
  rs.useRealTimers();
});

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
    expect(screen.getByText("Planning shell commands").textContent).toBe("Planning shell commands");

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

describe("activity indicator", () => {
  it("shows only Orbit and elapsed time for plain thinking, and names it for screen readers", () => {
    render(<LiveTurnActivity snapshot={null} hasText={false} />);
    const bubble = screen.getByRole("status");
    expect(bubble.classList.contains("rounded-16")).toBe(false);
    expect(bubble.querySelector("[data-variant=Orbit]")).toBeTruthy();
    expect(bubble.querySelectorAll("[data-slot=loader-grid-cell]")).toHaveLength(9);
    expect(bubble.querySelector("[data-slot=loading-state-label]")).toBeNull();
    expect(
      bubble.querySelector("[data-slot=loading-state-elapsed]")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(bubble.getAttribute("aria-label")).toBe("Working");
    expect(screen.getByText("Thinking…").className).toBe("sr-only");
  });

  it("cuts a specific step to one line inside the activity indicator", () => {
    render(
      <LiveTurnActivity snapshot={snapshot(thinking(0, "Checking results"))} hasText={false} />,
    );
    const label = screen.getByText("Checking results");
    expect(label.closest("[role=status]")?.classList.contains("rounded-16")).toBe(false);
    expect(label.closest("[role=status]")).toBeTruthy();
    expect(label.classList.contains("truncate")).toBe(true);
    expect(label.className).not.toContain("shimmer");
  });
});

describe("controlled activity time", () => {
  it("keeps the turn start through status/entrance changes, hidden activity and remounts", () => {
    rs.useFakeTimers();
    rs.setSystemTime(10_000);
    const trace = snapshot(thinking(0, "Checking results"));
    const { rerender, unmount } = render(
      <LiveTurnActivity snapshot={trace} hasText={false} startedAt={2_000} entranceKey="first" />,
    );
    expect(screen.getByText("8.0s").getAttribute("aria-hidden")).toBe("true");
    act(() => {
      rs.setSystemTime(12_000);
      rs.advanceTimersByTime(100);
    });
    rerender(
      <LiveTurnActivity
        snapshot={snapshot(thinking(1, "Verifying output"))}
        hasText={false}
        startedAt={2_000}
        entranceKey="next"
      />,
    );
    expect(screen.getByText("10.1s")).toBeTruthy();
    expect(screen.getByText("Verifying output").classList.contains("rome-status-fade")).toBe(true);
    rerender(
      <LiveTurnActivity snapshot={trace} hasText startedAt={2_000} textThroughOrdinal={0} />,
    );
    expect(screen.queryByLabelText("Working")).toBeNull();
    expect(rs.getTimerCount()).toBe(0);
    rerender(<LiveTurnActivity snapshot={null} hasText={false} startedAt={2_000} />);
    expect(screen.getByText("10.1s")).toBeTruthy();
    unmount();
    expect(rs.getTimerCount()).toBe(0);
    render(<LiveTurnActivity snapshot={null} hasText={false} startedAt={2_000} />);
    expect(screen.getByText("10.1s")).toBeTruthy();
  });
  it("uses a new start only for a new turn, and clamps future server times", () => {
    rs.useFakeTimers();
    rs.setSystemTime(10_000);
    const { rerender } = render(<LiveTurnActivity snapshot={null} hasText={false} startedAt={0} />);
    expect(screen.getByText("10.0s")).toBeTruthy();
    rerender(<LiveTurnActivity snapshot={null} hasText={false} startedAt={9_000} />);
    expect(screen.getByText("1.0s")).toBeTruthy();
    rerender(<LiveTurnActivity snapshot={null} hasText={false} startedAt={11_000} />);
    expect(screen.getByText("0.0s")).toBeTruthy();
  });
  it("keeps the existing plan/body/watermark and terminal-error hiding rules", () => {
    const trace = snapshot(thinking(2, "New activity"));
    const { rerender } = render(
      <LiveTurnActivity snapshot={trace} hasText textThroughOrdinal={1} startedAt={0} />,
    );
    expect(screen.getByText("New activity")).toBeTruthy();
    rerender(<LiveTurnActivity snapshot={trace} hasText textThroughOrdinal={2} startedAt={0} />);
    expect(screen.queryByLabelText("Working")).toBeNull();
    rerender(
      <LiveTurnActivity
        snapshot={{
          ...snapshot(),
          summary: {
            ...trace.summary,
            plan: { steps: [{ text: "Verify", status: "pending" }] },
          },
        }}
        hasText={false}
        startedAt={0}
      />,
    );
    expect(screen.queryByLabelText("Working")).toBeNull();
    rerender(
      <LiveTurnActivity
        snapshot={{
          ...trace,
          summary: {
            ...trace.summary,
            terminalError: { message: "Fixture failure" },
          },
        }}
        hasText={false}
        startedAt={0}
      />,
    );
    expect(screen.queryByLabelText("Working")).toBeNull();
  });
});
