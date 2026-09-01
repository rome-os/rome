// @rstest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TraceSubagentSummary } from "@rome/api-types/trace-segments";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { openTurnStream } from "@/lib/chat-api";
import { DelegatedSubagentGroup, type DelegatedSubagentNode } from "./DelegatedSubagentGroup";

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

rs.mock("@/lib/chat-api", () => ({
  openTurnStream: rs.fn(),
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

const openTurnStreamMock = rs.mocked(openTurnStream);

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
    expect(openTurnStreamMock).not.toHaveBeenCalled();
  });

  it("opens the selected child trace", async () => {
    const child = completedSubagent();
    const onOpen = rs.fn((_node: DelegatedSubagentNode) => {});
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

  it("does not consume a turn-stream connection for running children", () => {
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
    expect(openTurnStreamMock).not.toHaveBeenCalled();
  });
});
