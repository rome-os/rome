// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TraceAccounting } from "@rome/api-types/trace-segments";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UsageSummaryBlock } from "./UsageSummaryBlock";

rs.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === "usage.includedSubagents") return `${params?.count} subagents included`;
      if (key === "usage.runCount") return `${params?.count} runs`;
      if (key === "usage.modelCount") return `${params?.count} models`;
      return key;
    },
  }),
}));

beforeAll(() => {
  class TestResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = TestResizeObserver;
});

afterEach(() => cleanup());

describe("UsageSummaryBlock", () => {
  it("shows cross-model usage as a compact text breakdown", async () => {
    const user = userEvent.setup();
    const accounting: TraceAccounting = {
      provider: "anthropic",
      model: "main-model",
      usage: {
        cacheReadTokens: 30,
        cacheWriteTokens: 20,
        inputTokens: 30,
        outputTokens: 20,
      },
      context: { usedTokens: 25, windowTokens: 100 },
      costUsd: 0.3,
      includedSubagentCount: 2,
      usageByModel: [
        {
          provider: "anthropic",
          model: "main-model",
          usage: {
            cacheReadTokens: 25,
            cacheWriteTokens: 15,
            inputTokens: 25,
            outputTokens: 10,
          },
          costUsd: 0.1,
          runCount: 1,
        },
        {
          provider: "openai",
          model: "child-model",
          usage: {
            cacheReadTokens: 5,
            cacheWriteTokens: 5,
            inputTokens: 5,
            outputTokens: 10,
          },
          costUsd: 0.2,
          runCount: 2,
        },
      ],
    };

    render(
      <TooltipProvider>
        <UsageSummaryBlock accounting={accounting} />
      </TooltipProvider>,
    );

    expect(screen.getByText("anthropic / main-model")).toBeTruthy();
    expect(screen.getByText("openai / child-model")).toBeTruthy();
    expect(screen.getByText("2 runs")).toBeTruthy();
    expect(screen.getByText("2 models")).toBeTruthy();
    expect(screen.getByText("25 / 100")).toBeTruthy();
    expect(screen.getByText("$0.1000")).toBeTruthy();
    expect(screen.getByText("$0.2000")).toBeTruthy();
    expect(screen.getByText("$0.3000")).toBeTruthy();
    const contextProgress = screen.getByRole("progressbar", { name: "usage.contextUsage" });
    expect(contextProgress.getAttribute("aria-valuenow")).toBe("25");
    expect(screen.queryByText("usage.contextUsage: 25%")).toBeNull();

    await user.hover(contextProgress);
    expect((await screen.findAllByText("usage.contextUsage: 25%")).length).toBeGreaterThan(0);
  });
});
