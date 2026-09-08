// @rstest-environment jsdom
import { afterEach, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TraceSummary } from "@rome/api-types/trace-segments";
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
  const { rerender } = render(<CollapsedTraceButton onClick={onClick} live compact />);
  fireEvent.click(screen.getByRole("button", { name: "0 apps · 0 steps" }));
  expect(onClick).toHaveBeenCalledTimes(1);

  rerender(<CollapsedTraceButton summary={summary} onClick={onClick} live compact />);
  const entry = screen.getByRole("button", { name: "1 app · 1 step" });
  expect(entry.querySelector("img")).not.toBeNull();
  expect(entry.querySelector(".shimmer")).toBeNull();
  expect(screen.queryByText("Using System")).toBeNull();

  rerender(
    <CollapsedTraceButton summary={{ ...summary, totalSteps: 2 }} onClick={onClick} live compact />,
  );
  expect(screen.getByRole("button", { name: "1 app · 2 steps" })).toBeTruthy();
  expect(screen.queryByText("Thinking…")).toBeNull();
});

it("keeps settled zero-tool turns readable and their trace accessible", () => {
  const onClick = rs.fn();
  const summary: TraceSummary = {
    distinctApps: [],
    totalSteps: 0,
    invocationCounts: {},
    totalDurationMs: 3100,
  };
  const { rerender } = render(
    <CollapsedTraceButton summary={summary} onClick={onClick} live compact />,
  );
  expect(screen.getByRole("button").textContent).toBe("0 apps · 0 steps");
  rerender(<CollapsedTraceButton summary={summary} onClick={onClick} compact />);
  const entry = screen.getByRole("button", { name: "Thought for 3.1s" });
  expect(entry.querySelector(".rounded-full")).toBeNull();
  fireEvent.click(entry);
  expect(onClick).toHaveBeenCalledTimes(1);
  rerender(
    <CollapsedTraceButton
      summary={{ ...summary, stoppedByUser: true }}
      onClick={onClick}
      compact
    />,
  );
  expect(screen.getByRole("button").textContent).toBe("Stopped by user");
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
