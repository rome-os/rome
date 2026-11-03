// @rstest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { FakeTurnStream, runSegment, stepsSummary } from "@/test/fake-turn-stream";
import { SubagentCallView } from "./SubagentCallView";

rs.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number }) => {
      if (key === "trace.summary.stepsSingle") return `${params?.count} step`;
      if (key === "trace.summary.stepsMultiple") return `${params?.count} steps`;
      if (key === "trace.summary.joiner") return " · ";
      return key;
    },
  }),
}));

let streams = new Map<string, FakeTurnStream>();
rs.mock("@/lib/chat-api", () => ({
  openTurnStream: async (turnId: string) => {
    const stream = new FakeTurnStream();
    streams.set(turnId, stream);
    return stream.response;
  },
}));

beforeEach(() => {
  streams = new Map();
});
afterEach(cleanup);

describe("SubagentCallView", () => {
  it("renders one dedicated Child execution row and links to its session", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SubagentCallView
          agentName="planning"
          input={{ prompt: "Inspect the repository" }}
          sessionId="child-session"
          turnId="child-turn"
          status="completed"
          output={{ result: "done" }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("planning")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();

    await user.click(screen.getByRole("button"));

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/sessions/child-session");
    expect(screen.getByText("child-session / child-turn")).toBeTruthy();
  });

  describe("while running", () => {
    // A released stream lingers one tick, so every test runs its own turn.
    let seq = 0;
    function view(turnId: string, status: "running" | "completed" = "running", extra = {}) {
      return (
        <MemoryRouter>
          <SubagentCallView
            agentName="planning"
            sessionId="child-session"
            turnId={turnId}
            status={status}
            {...extra}
          />
        </MemoryRouter>
      );
    }

    it("says running until the first step arrives", async () => {
      const turnId = `row-turn-${(seq += 1)}`;
      render(view(turnId));
      await waitFor(() => expect(streams.has(turnId)).toBe(true));
      expect(screen.getByText("running")).toBeTruthy();
    });

    it("shows the step count and elapsed time, with the current step as the tooltip", async () => {
      const turnId = `row-turn-${(seq += 1)}`;
      render(view(turnId));
      await waitFor(() => expect(streams.has(turnId)).toBe(true));
      const startedAt = new Date(Date.now() - 80_000).toISOString();
      await act(async () => {
        const stream = streams.get(turnId)!;
        stream.send(
          "segment_upsert",
          runSegment("run-1", [{ tool: "Bash", input: { command: "ls" }, startedAt }]),
        );
        stream.send("summary_update", stepsSummary(3));
      });
      const label = await screen.findByText("3 steps · 1m 20s");
      expect(screen.queryByText("running")).toBeNull();
      expect(label.title).toContain("Bash");
    });

    it("counts from the call's start, not from its first step", async () => {
      const turnId = `row-turn-${(seq += 1)}`;
      render(view(turnId, "running", { startedAt: new Date(Date.now() - 80_000).toISOString() }));
      await waitFor(() => expect(streams.has(turnId)).toBe(true));
      const firstStep = new Date(Date.now() - 20_000).toISOString();
      await act(async () => {
        const stream = streams.get(turnId)!;
        stream.send(
          "segment_upsert",
          runSegment("run-1", [{ tool: "Bash", input: {}, startedAt: firstStep }]),
        );
        stream.send("summary_update", stepsSummary(1));
      });
      expect(await screen.findByText("1 step · 1m 20s")).toBeTruthy();
    });

    it("opens no stream for a call that already finished", () => {
      render(view(`row-turn-${(seq += 1)}`, "completed"));
      expect(streams.size).toBe(0);
    });
  });
});
