// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "@/i18n";
import type { Routine } from "@/lib/routine-language";
import RoutineDetailPage from "./RoutineDetailPage";

const routine: Routine = {
  id: "r-1",
  name: "Daily work summary",
  enabled: true,
  trigger: {
    type: "schedule",
    tzid: "America/Los_Angeles",
    tzMode: "floating",
    localTime: "12:25",
    rrule: "FREQ=DAILY",
  },
  actionName: "system:summon",
  args: { agentName: "core:main", prompt: "Summarize the last 24 hours.", maxTurns: 3 },
  createdAt: "2026-11-01T00:00:00Z",
  lastFiredAt: null,
  nextRunAt: null,
};

// The page reads the routine list and its runs through these hooks; stub them
// so it renders from fixture data alone.
rs.mock("@/hooks/use-routines", () => ({
  useRoutines: () => ({
    routines: [routine],
    isLoading: false,
    isFetching: false,
    isFetchedAfterMount: true,
  }),
  useRoutineRuns: () => ({ runs: [], isLoading: false, error: null }),
  useRoutineRunTrace: () => ({ trace: null, isLoading: false, error: null }),
}));

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => cleanup());

describe("RoutineDetailPage", () => {
  it("shows what the routine runs: the action and each argument", () => {
    render(
      <MemoryRouter initialEntries={["/routines/r-1"]}>
        <Routes>
          <Route path="/routines/:id" element={<RoutineDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "What it runs" })).toBeTruthy();
    expect(screen.getByText("system:summon")).toBeTruthy();
    expect(screen.getByText("Agent name")).toBeTruthy();
    expect(screen.getByText("core:main")).toBeTruthy();
    expect(screen.getByText("Prompt")).toBeTruthy();
    expect(screen.getByText("Summarize the last 24 hours.")).toBeTruthy();
    // Non-string arguments render as JSON.
    expect(screen.getByText("Max turns")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });
});
