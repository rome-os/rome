// @rstest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TraceSubagentSummary } from "@rome/api-types/trace-segments";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { FakeTurnStream, runSegment, stepsSummary } from "@/test/fake-turn-stream";
import { DelegatedSubagentGroup } from "./DelegatedSubagentGroup";

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

rs.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: { agent?: string; count?: number }) => {
      const labels: Record<string, string> = {
        "trace.subagents.ariaLabel": "Delegated subagents",
        "trace.subagents.status.running": "running",
        "trace.subagents.status.completed": "completed",
        "trace.subagents.status.failed": "failed",
        "trace.subagents.status.cancelled": "cancelled",
        "trace.summary.activity.thinking": "Thinking…",
        "trace.summary.joiner": " · ",
      };
      if (key === "trace.subagents.openTrace") return `Open trace for ${params?.agent}`;
      if (key === "trace.summary.stepsSingle") return `${params?.count} step`;
      if (key === "trace.summary.stepsMultiple") return `${params?.count} steps`;
      return labels[key] ?? key;
    },
  }),
}));

rs.mock("@/components/chat/AgentAvatar", () => ({
  AgentAvatar: ({
    iconUrl,
    label,
    size,
    className,
  }: {
    iconUrl?: string | null;
    label?: string | null;
    size?: string;
    className?: string;
  }) => (
    <span
      data-slot="avatar"
      data-icon-url={iconUrl ?? ""}
      data-label={label ?? ""}
      data-size={size ?? "default"}
      className={className}
    />
  ),
}));

afterEach(() => {
  cleanup();
  rs.clearAllMocks();
});

function completedSubagent(overrides: Partial<TraceSubagentSummary> = {}): TraceSubagentSummary {
  return {
    toolUseId: "subagent-1",
    agentName: "coding:planning",
    sessionId: "child-session",
    turnId: "child-turn",
    status: "completed",
    traceSummary: {
      distinctApps: [{ id: "coding", name: "Coding", iconUrl: "/api/apps/coding/icon" }],
      totalSteps: 2,
      totalDurationMs: 3200,
      invocationCounts: { coding: 2 },
    },
    ...overrides,
  };
}

describe("DelegatedSubagentGroup", () => {
  it("renders three subordinate micro items in one group", () => {
    const children = [
      completedSubagent(),
      completedSubagent({
        toolUseId: "subagent-2",
        agentName: "research",
        sessionId: "research-session",
        turnId: "research-turn",
        traceSummary: {
          distinctApps: [],
          totalSteps: 0,
          totalDurationMs: 6000,
          invocationCounts: {},
        },
      }),
      completedSubagent({
        toolUseId: "subagent-3",
        agentName: "reviewer",
        sessionId: "review-session",
        turnId: "review-turn",
        traceSummary: {
          distinctApps: [],
          totalSteps: 1,
          totalDurationMs: 900,
          invocationCounts: {},
        },
      }),
    ];

    const { container } = render(
      <DelegatedSubagentGroup
        subagents={children}
        agentIconByName={new Map([["coding:planning", "/api/apps/coding/icon"]])}
        onOpenSubagentTrace={() => {}}
      />,
    );

    expect(screen.getByRole("list", { name: "Delegated subagents" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("planning")).toBeTruthy();
    expect(screen.getByText("research")).toBeTruthy();
    expect(screen.getByText("reviewer")).toBeTruthy();
    expect(screen.getByText("2 steps · 3.2s")).toBeTruthy();
    expect(screen.getByText("6.0s")).toBeTruthy();
    expect(screen.getByText("1 step · 900ms")).toBeTruthy();
    expect(container.querySelectorAll("[data-subagent-separator]")).toHaveLength(3);
    expect(container.querySelector("svg[data-subagent-connectors]")).toBeNull();
  });

  it("opens the selected child trace", async () => {
    const child = completedSubagent();
    const onOpen = rs.fn((_node: TraceSubagentSummary) => {});
    render(
      <DelegatedSubagentGroup
        subagents={[child]}
        selected={{ sessionId: "child-session", turnId: "child-turn" }}
        agentIconByName={new Map([["coding:planning", "/api/apps/coding/icon"]])}
        onOpenSubagentTrace={onOpen}
      />,
    );

    const planning = screen.getByRole("button", { name: "Open trace for planning" });
    expect(planning.getAttribute("aria-current")).toBe("true");
    expect(planning.querySelector('[data-slot="avatar"]')?.getAttribute("data-icon-url")).toBe(
      "/api/apps/coding/icon",
    );
    expect(planning.querySelector('[data-slot="avatar"]')?.getAttribute("data-size")).toBe(
      "default",
    );
    expect(planning.querySelector('[data-slot="avatar"]')?.className).toContain("size-3");
    await act(async () => fireEvent.click(planning));
    expect(onOpen).toHaveBeenCalledWith(child);
  });

  it("shows running children as thinking", () => {
    const children = Array.from({ length: 4 }, (_, index) =>
      completedSubagent({
        toolUseId: `subagent-${index}`,
        agentName: `worker-${index}`,
        sessionId: `child-session-${index}`,
        turnId: `child-turn-${index}`,
        status: "running",
        traceSummary: undefined,
      }),
    );

    render(<DelegatedSubagentGroup subagents={children} onOpenSubagentTrace={() => {}} />);

    expect(screen.getAllByText("Thinking…")).toHaveLength(4);
  });

  describe("while a child runs", () => {
    // A released stream lingers one tick, so every test runs its own turn.
    let turnId = "";
    let seq = 0;
    beforeEach(() => {
      seq += 1;
      turnId = `live-child-turn-${seq}`;
    });

    function runningChild(overrides: Partial<TraceSubagentSummary> = {}) {
      return completedSubagent({
        status: "running",
        traceSummary: undefined,
        turnId,
        ...overrides,
      });
    }

    it("keeps Thinking… until the first step arrives", async () => {
      render(
        <DelegatedSubagentGroup subagents={[runningChild()]} onOpenSubagentTrace={() => {}} />,
      );
      await waitFor(() => expect(streams.has(turnId)).toBe(true));
      expect(screen.getByText("Thinking…")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Open trace for planning" }).title).toBe("");
    });

    it("shows the live step count and elapsed time, with the current step as the tooltip", async () => {
      render(
        <DelegatedSubagentGroup subagents={[runningChild()]} onOpenSubagentTrace={() => {}} />,
      );
      await waitFor(() => expect(streams.has(turnId)).toBe(true));
      const stream = streams.get(turnId)!;
      const startedAt = new Date(Date.now() - 80_000).toISOString();
      await act(async () => {
        stream.send(
          "segment_upsert",
          runSegment("run-1", [
            { tool: "Read", input: { path: "a.ts" }, startedAt },
            { tool: "Edit", input: { path: "TraceDrawer.tsx" } },
          ]),
        );
        stream.send("summary_update", stepsSummary(7));
      });

      expect(await screen.findByText("7 steps · 1m 20s")).toBeTruthy();
      expect(screen.queryByText("Thinking…")).toBeNull();
      expect(screen.getByRole("button", { name: "Open trace for planning" }).title).toBe(
        "Edit TraceDrawer.tsx",
      );
    });

    it("reads 1 step in the singular", async () => {
      render(
        <DelegatedSubagentGroup subagents={[runningChild()]} onOpenSubagentTrace={() => {}} />,
      );
      await waitFor(() => expect(streams.has(turnId)).toBe(true));
      await act(async () => {
        streams.get(turnId)!.send("summary_update", stepsSummary(1));
      });
      expect(await screen.findByText("1 step")).toBeTruthy();
    });

    it("falls back to the stored summary once the run ends", async () => {
      const props = { onOpenSubagentTrace: () => {} };
      const { rerender } = render(
        <DelegatedSubagentGroup subagents={[runningChild()]} {...props} />,
      );
      await waitFor(() => expect(streams.has(turnId)).toBe(true));
      await act(async () => {
        streams.get(turnId)!.send("summary_update", stepsSummary(7));
      });
      await screen.findByText("7 steps");

      rerender(
        <DelegatedSubagentGroup
          subagents={[
            runningChild({
              status: "completed",
              traceSummary: {
                distinctApps: [],
                totalSteps: 8,
                totalDurationMs: 3200,
                invocationCounts: {},
              },
            }),
          ]}
          {...props}
        />,
      );
      expect(screen.getByText("8 steps · 3.2s")).toBeTruthy();
      expect(screen.queryByText("7 steps")).toBeNull();
    });

    it("keeps the status text for a child that failed", async () => {
      const props = { onOpenSubagentTrace: () => {} };
      const { rerender } = render(
        <DelegatedSubagentGroup subagents={[runningChild()]} {...props} />,
      );
      await waitFor(() => expect(streams.has(turnId)).toBe(true));
      await act(async () => {
        streams.get(turnId)!.send("summary_update", stepsSummary(2));
      });
      await screen.findByText("2 steps");
      rerender(
        <DelegatedSubagentGroup subagents={[runningChild({ status: "failed" })]} {...props} />,
      );
      expect(screen.getByText("failed")).toBeTruthy();
    });

    it("opens no stream for a completed child it never saw running", () => {
      render(
        <DelegatedSubagentGroup
          subagents={[runningChild({ status: "completed" })]}
          onOpenSubagentTrace={() => {}}
        />,
      );
      expect(streams.size).toBe(0);
      expect(screen.getByText("completed")).toBeTruthy();
    });

    it("opens no stream for a child that is not running", () => {
      render(
        <DelegatedSubagentGroup subagents={[completedSubagent()]} onOpenSubagentTrace={() => {}} />,
      );
      expect(streams.size).toBe(0);
    });
  });
});
