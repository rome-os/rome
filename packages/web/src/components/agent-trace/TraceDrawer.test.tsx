// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TraceAccounting, TraceSnapshot } from "@rome/api-types/trace-segments";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { UsageSummaryView } from "@/components/chat/entries/UsageSummaryView";
import { TraceDrawer, type TraceDrawerTarget } from "./TraceDrawer";

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

describe("TraceDrawer archived steps", () => {
  it("handles a stale trace link without showing steps, retry, or download", async () => {
    const fetch = rs.fn(
      async () => new Response(JSON.stringify({ trace: null, traceArchived: true })),
    );
    rs.stubGlobal("fetch", fetch);
    try {
      render(
        <TraceDrawer
          target={{
            kind: "stored",
            messageId: "old",
            sessionId: "s",
            turnId: "t",
            summary: targetSummary,
          }}
          onClose={() => {}}
          renderInlineBlock={() => null}
          renderRunBlocks={() => null}
        />,
      );
      expect(await screen.findByText("trace.archived")).toBeTruthy();
      expect(screen.queryByRole("link", { name: "trace.drawer.dumpAriaLabel" })).toBeNull();
      expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    } finally {
      rs.unstubAllGlobals();
    }
  });
});

describe("TraceDrawer hosted in the tool pane", () => {
  const storedTarget = {
    kind: "stored" as const,
    messageId: "m",
    sessionId: "s",
    turnId: "t",
    summary: targetSummary,
  };
  const loadStoredTrace = async () => usageSnapshot(false);

  function hosted(outlet: HTMLElement | null, target: TraceDrawerTarget | null = storedTarget) {
    return (
      <TraceDrawer
        target={target}
        onClose={() => {}}
        outlet={outlet}
        loadStoredTrace={loadStoredTrace}
        renderInlineBlock={() => null}
        renderRunBlocks={() => null}
      />
    );
  }

  it("renders into the outlet with only the summary and the dump link as its header", async () => {
    const outlet = document.createElement("div");
    document.body.append(outlet);
    render(hosted(outlet));

    await waitFor(() => expect(outlet.textContent).toContain("trace.summary.stepsSingle"));
    expect(outlet.querySelector("a[download]")?.getAttribute("href")).toBe(
      "/api/chat/sessions/s/turns/t/trace.json",
    );
    // The tab owns the title, the Live indicator and the close button.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("heading", { name: "trace.drawer.title" })).toBeNull();
    expect(screen.queryByRole("button", { name: "trace.drawer.closeAriaLabel" })).toBeNull();
    expect(screen.queryByText("trace.drawer.live")).toBeNull();
    outlet.remove();
  });

  it("renders nothing until the tab's outlet exists, then fills it", async () => {
    const { container, rerender } = render(hosted(null));
    expect(container.textContent).toBe("");
    const outlet = document.createElement("div");
    document.body.append(outlet);
    rerender(hosted(outlet));
    await waitFor(() => expect(outlet.textContent).toContain("trace.summary.stepsSingle"));
    outlet.remove();
  });

  it("renders nothing without a target", () => {
    const outlet = document.createElement("div");
    document.body.append(outlet);
    render(hosted(outlet, null));
    expect(outlet.textContent).toBe("");
    outlet.remove();
  });

  it("stays a dialog overlay when no outlet is given", () => {
    render(
      <TraceDrawer
        target={null}
        onClose={() => {}}
        renderInlineBlock={() => null}
        renderRunBlocks={() => null}
      />,
    );
    expect(document.querySelector('aside[role="dialog"]')).not.toBeNull();
  });

  it("follows a live trace to the bottom once the outlet mounts", () => {
    const heights = new WeakMap<Element, number>();
    const scrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
    const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(Element.prototype, "scrollHeight", {
      configurable: true,
      get: () => 500,
    });
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get(this: Element) {
        return heights.get(this) ?? 0;
      },
      set(this: Element, value: number) {
        heights.set(this, value);
      },
    });
    try {
      const live: TraceDrawerTarget = {
        kind: "live",
        sessionId: "s",
        turnId: "t",
        summary: targetSummary,
        segments: [],
        streaming: true,
      };
      const { rerender } = render(hosted(null, live));
      const outlet = document.createElement("div");
      document.body.append(outlet);
      rerender(hosted(outlet, live));

      const scroller = outlet.querySelector(".overflow-y-auto");
      expect(scroller).not.toBeNull();
      expect(heights.get(scroller as Element)).toBe(500);
      outlet.remove();
    } finally {
      if (scrollHeight) Object.defineProperty(Element.prototype, "scrollHeight", scrollHeight);
      else delete (Element.prototype as { scrollHeight?: number }).scrollHeight;
      if (scrollTop) Object.defineProperty(Element.prototype, "scrollTop", scrollTop);
      else delete (Element.prototype as { scrollTop?: number }).scrollTop;
    }
  });

  it("ignores Escape in the tab, where the overlay would close", async () => {
    const outlet = document.createElement("div");
    document.body.append(outlet);
    const onClose = rs.fn();
    render(
      <TraceDrawer
        target={storedTarget}
        onClose={onClose}
        outlet={outlet}
        loadStoredTrace={loadStoredTrace}
        renderInlineBlock={() => null}
        renderRunBlocks={() => null}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    outlet.remove();
  });

  it("leaves focus alone when the tab's trace closes", () => {
    const outlet = document.createElement("div");
    const trigger = document.createElement("button");
    const elsewhere = document.createElement("button");
    document.body.append(outlet, trigger, elsewhere);
    trigger.focus();
    const props = {
      onClose: () => {},
      outlet,
      loadStoredTrace,
      renderInlineBlock: () => null,
      renderRunBlocks: () => null,
    };
    const { rerender } = render(<TraceDrawer target={storedTarget} {...props} />);
    elsewhere.focus();
    rerender(<TraceDrawer target={null} {...props} />);
    expect(document.activeElement).toBe(elsewhere);
    outlet.remove();
    trigger.remove();
    elsewhere.remove();
  });

  it("still closes the overlay on Escape", () => {
    const onClose = rs.fn();
    render(
      <TraceDrawer
        target={storedTarget}
        onClose={onClose}
        loadStoredTrace={loadStoredTrace}
        renderInlineBlock={() => null}
        renderRunBlocks={() => null}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the archived note without a dump link", async () => {
    const outlet = document.createElement("div");
    document.body.append(outlet);
    render(
      <TraceDrawer
        target={storedTarget}
        onClose={() => {}}
        outlet={outlet}
        loadStoredTrace={async () => "archived"}
        renderInlineBlock={() => null}
        renderRunBlocks={() => null}
      />,
    );
    await waitFor(() => expect(outlet.textContent).toContain("trace.archived"));
    expect(outlet.querySelector("a[download]")).toBeNull();
    outlet.remove();
  });
});
