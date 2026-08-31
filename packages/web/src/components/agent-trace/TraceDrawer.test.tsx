// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TraceAccounting, TraceSnapshot } from "@rome/api-types/trace-segments";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { UsageSummaryBlock } from "@/components/chat/blocks/UsageSummaryBlock";
import {
  TraceDrawer,
  traceDrawerContentInsetClass,
  traceDrawerOpenPlacementClass,
} from "./TraceDrawer";

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

describe("traceDrawerOpenPlacementClass", () => {
  it("always covers the desktop chat column when an app is open", () => {
    const classes = traceDrawerOpenPlacementClass(true);

    expect(classes).toContain("top-[var(--rome-mobile-header-height)]");
    expect(classes).not.toContain("pb-safe");
    expect(classes).toContain("md:left-[var(--rome-chat-left,0px)]");
    expect(classes).toContain("md:right-auto");
    expect(classes).toContain("md:w-[var(--rome-chat-col)]");
    expect(classes).not.toContain("@5xl/chat:w-[480px]");
  });

  it("covers the full narrow chat when no app is open", () => {
    const classes = traceDrawerOpenPlacementClass(false);

    expect(classes).toContain("top-[var(--rome-mobile-header-height)]");
    expect(classes).not.toContain("top-12");
    expect(classes).not.toContain("pb-safe");
    expect(classes).toContain("@max-5xl/chat:md:left-[var(--rome-chat-left,0px)]");
    expect(classes).toContain("@max-5xl/chat:md:right-0");
    expect(classes).toContain("@max-5xl/chat:md:w-auto");
    expect(classes).not.toContain(["@max-5xl/chat:md:w-", "[var(--rome-chat-col)]"].join(""));
  });

  it("docks a 480px inspector to the right of a wide chat with no apps", () => {
    const classes = traceDrawerOpenPlacementClass(false);

    expect(classes).toContain("@5xl/chat:left-auto");
    expect(classes).toContain("@5xl/chat:right-0");
    expect(classes).toContain("@5xl/chat:w-[480px]");
  });

  it("reserves side-panel space only for an open trace with no apps", () => {
    expect(traceDrawerContentInsetClass(true, false)).toBe(
      "@5xl/chat:flex-none @5xl/chat:w-[calc(100%-480px)]",
    );
    expect(traceDrawerContentInsetClass(true, true)).toBe("");
    expect(traceDrawerContentInsetClass(false, false)).toBe("@5xl/chat:flex-none @5xl/chat:w-full");
    expect(traceDrawerContentInsetClass(false, true)).toBe("");
  });
});

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
            <UsageSummaryBlock accounting={block.accounting} />
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
