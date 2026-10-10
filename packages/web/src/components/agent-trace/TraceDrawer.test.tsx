// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TraceAccounting, TraceSnapshot } from "@rome/api-types/trace-segments";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { UsageSummaryView } from "@/components/chat/entries/UsageSummaryView";
import { TraceDrawer } from "./TraceDrawer";

const translate = (key: string) => key;
rs.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));

afterEach(() => cleanup());

const baseAccounting: TraceAccounting = {
  provider: "openai",
  model: "gpt-test",
  usage: {
    cacheReadTokens: 1,
    cacheWriteTokens: 2,
    inputTokens: 3,
    outputTokens: 4,
  },
  costUsd: 0.01,
};

const targetSummary = {
  distinctApps: [],
  totalSteps: 1,
  invocationCounts: {},
  subagents: [
    {
      toolUseId: "delegate-1",
      agentName: "planning",
      sessionId: "child-session",
      turnId: "child-turn",
      status: "completed" as const,
    },
  ],
};

function usageSnapshot(includeSubagents: boolean): TraceSnapshot {
  const accounting = includeSubagents
    ? {
        ...baseAccounting,
        usage: { ...baseAccounting.usage, inputTokens: 13, outputTokens: 9 },
        includedSubagentCount: 1,
      }
    : baseAccounting;
  return {
    summary: targetSummary,
    segments: [
      {
        kind: "block",
        id: "result",
        ordinal: 0,
        block: { type: "result", content: "done", accounting },
      },
    ],
  };
}

describe("TraceDrawer subagent usage", () => {
  it("loads included usage by default and refetches when the switch is disabled", async () => {
    const loadStoredTrace = rs.fn(async (_messageId: string, include: boolean) =>
      usageSnapshot(include),
    );
    render(
      <TraceDrawer
        target={{
          kind: "stored",
          messageId: "parent-trace",
          sessionId: "parent-session",
          turnId: "parent-turn",
          summary: targetSummary,
        }}
        onClose={() => {}}
        loadStoredTrace={loadStoredTrace}
        renderInlineBlock={(block) =>
          block.type === "result" && block.accounting ? (
            <UsageSummaryView accounting={block.accounting} />
          ) : null
        }
        renderRunBlocks={() => null}
      />,
    );

    const usageSwitch = await screen.findByRole("switch", {
      name: "usage.includeSubagents",
    });
    expect(usageSwitch.getAttribute("data-state")).toBe("checked");
    expect(loadStoredTrace).toHaveBeenCalledWith("parent-trace", true);
    expect(await screen.findByText("13")).toBeTruthy();

    fireEvent.click(usageSwitch);
    await waitFor(() => {
      expect(loadStoredTrace).toHaveBeenCalledWith("parent-trace", false);
    });
    expect(await screen.findByText("3")).toBeTruthy();
  });
});
