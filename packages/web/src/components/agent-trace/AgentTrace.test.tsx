// @rstest-environment jsdom
import { afterEach, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TraceSegment, TraceSummary } from "@rome/api-types/trace-segments";
import { CollapsedTraceButton } from "./AgentTrace";
import "@/i18n";

afterEach(cleanup);

it("keeps the live transcript header as a trace entry while activity changes", () => {
  const onClick = rs.fn();
  const summary: TraceSummary = {
    distinctApps: [{ id: "system", name: "System", iconUrl: "/icon.svg" }],
    totalSteps: 1,
    invocationCounts: { system: 1 },
  };
  const run: TraceSegment = {
    kind: "run",
    id: "run",
    ordinal: 0,
    app: summary.distinctApps[0],
    count: 1,
    blocks: [{ type: "tool_use", tool: "shell", input: {} }],
  };
  const { rerender } = render(<CollapsedTraceButton onClick={onClick} live compact />);
  fireEvent.click(screen.getByRole("button", { name: "0 apps · 0 steps" }));
  expect(onClick).toHaveBeenCalledTimes(1);

  rerender(
    <CollapsedTraceButton summary={summary} segments={[run]} onClick={onClick} live compact />,
  );
  const entry = screen.getByRole("button", { name: "1 app · 1 step" });
  expect(entry.querySelector("img")).not.toBeNull();
  expect(entry.querySelector(".shimmer")).toBeNull();
  expect(screen.queryByText("Using System")).toBeNull();

  rerender(
    <CollapsedTraceButton
      summary={{ ...summary, totalSteps: 2 }}
      segments={[
        run,
        {
          kind: "block",
          id: "thinking",
          ordinal: 1,
          block: { type: "thinking", content: "Checking results" },
        },
      ]}
      onClick={onClick}
      live
      compact
    />,
  );
  expect(screen.getByRole("button", { name: "1 app · 2 steps" })).toBeTruthy();
  expect(screen.queryByText("Thinking…")).toBeNull();
});

it("preserves the stopped-turn label in the compact trace entry", () => {
  render(
    <CollapsedTraceButton
      summary={{ distinctApps: [], totalSteps: 0, invocationCounts: {}, stoppedByUser: true }}
      onClick={() => {}}
      live
      compact
    />,
  );
  expect(screen.queryByRole("button", { name: "0 apps · 0 steps" })).toBeNull();
  expect(screen.getByRole("button").textContent).toContain("stopped");
});

it("shows duration only after the live turn settles", () => {
  const summary: TraceSummary = {
    distinctApps: [],
    totalSteps: 2,
    invocationCounts: {},
    totalDurationMs: 40000,
  };
  const { rerender } = render(
    <CollapsedTraceButton summary={summary} onClick={() => {}} live compact />,
  );
  expect(screen.getByRole("button").textContent).toBe("0 apps · 2 steps");
  rerender(<CollapsedTraceButton summary={summary} onClick={() => {}} compact />);
  expect(screen.getByRole("button").textContent).toBe("0 apps · 2 steps · 40s");
});
