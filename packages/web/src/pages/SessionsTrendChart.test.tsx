// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SessionMetricGroup, SessionMetricsBucket } from "@rome/api-types/sessions";
import { afterAll, afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { SessionsTrendChart } from "./SessionsTrendChart";

const usage = (totalTokens: number) => ({
  inputTokens: totalTokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens,
  costUsd: totalTokens / 100_000,
  costedRunCount: 1,
});

const outcomes = { completed: 1, interrupted: 0, error: 0, unknown: 0 };

const series: SessionMetricGroup[] = [
  {
    key: "model:openai:gpt-5.6",
    label: "gpt-5.6",
    description: "openai",
    iconUrl: null,
    kind: "named",
    dimension: {
      dimension: "model",
      state: "known",
      provider: "openai",
      name: "gpt-5.6",
      label: "gpt-5.6",
    },
    sessionCount: 1,
    runCount: 1,
    usage: usage(120),
    outcomes,
    lastActivityAt: "2026-07-11T00:00:00.000Z",
  },
  {
    key: "model:anthropic:claude-sonnet-5",
    label: "claude-sonnet-5",
    description: "anthropic",
    iconUrl: null,
    kind: "named",
    dimension: {
      dimension: "model",
      state: "known",
      provider: "anthropic",
      name: "claude-sonnet-5",
      label: "claude-sonnet-5",
    },
    sessionCount: 1,
    runCount: 1,
    usage: usage(80),
    outcomes,
    lastActivityAt: "2026-07-11T00:00:00.000Z",
  },
];

const appSeries: SessionMetricGroup = {
  ...series[0],
  key: "app:calendar",
  label: "Calendar",
  description: "Agent owner",
  dimension: {
    dimension: "app",
    state: "installed",
    appId: "calendar",
    label: "Calendar",
    iconUrl: null,
  },
};

const buckets: SessionMetricsBucket[] = [
  {
    bucket: "2026-07-10",
    sessionCount: 1,
    runCount: 2,
    usage: usage(100),
    outcomes: { completed: 2, interrupted: 0, error: 0, unknown: 0 },
    values: [
      { key: series[0].key, sessionCount: 1, runCount: 1, usage: usage(70), outcomes },
      { key: series[1].key, sessionCount: 1, runCount: 1, usage: usage(30), outcomes },
    ],
  },
  {
    bucket: "2026-07-11",
    sessionCount: 1,
    runCount: 2,
    usage: usage(100),
    outcomes: { completed: 2, interrupted: 0, error: 0, unknown: 0 },
    values: [
      { key: series[0].key, sessionCount: 1, runCount: 1, usage: usage(50), outcomes },
      { key: series[1].key, sessionCount: 1, runCount: 1, usage: usage(50), outcomes },
    ],
  },
];

beforeAll(() => {
  class TestResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = TestResizeObserver;
  rs.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    const measuringText = this.id === "recharts_measurement_span";
    const width = measuringText ? 40 : 1_000;
    const height = measuringText ? 14 : 220;
    return {
      width,
      height,
      top: 0,
      right: width,
      bottom: height,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  });
});

afterEach(() => cleanup());
afterAll(() => rs.restoreAllMocks());

describe("SessionsTrendChart", () => {
  it("renders a Recharts stack and keeps legend drill-down behavior", () => {
    const onSeriesSelect = rs.fn();
    const { container } = render(
      <SessionsTrendChart
        buckets={buckets}
        series={series}
        metric="tokens"
        onSeriesSelect={onSeriesSelect}
      />,
    );

    expect(screen.getByRole("img", { name: "tokens usage trend with 2 series" })).toBeTruthy();
    expect(container.querySelector(".recharts-wrapper")).toBeTruthy();
    expect(container.querySelectorAll(".recharts-area-area")).toHaveLength(2);
    expect(screen.getByText("Jul 10")).toBeTruthy();
    expect(screen.getByText("Jul 11")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Filter Sessions by gpt-5.6" }));
    expect(onSeriesSelect).toHaveBeenCalledWith(series[0]);
  });

  it("keeps an explicit empty state", () => {
    render(<SessionsTrendChart buckets={[]} series={[]} metric="runs" onSeriesSelect={rs.fn()} />);

    expect(screen.getByText("No runs in this period")).toBeTruthy();
  });

  it("does not show the no-runs state when the selected metric is zero", () => {
    render(
      <SessionsTrendChart
        buckets={buckets}
        series={series}
        metric="errors"
        onSeriesSelect={rs.fn()}
      />,
    );

    expect(screen.queryByText("No runs in this period")).toBeNull();
  });

  it("keeps descriptions for non-model legend entries", () => {
    render(
      <SessionsTrendChart
        buckets={[]}
        series={[appSeries]}
        metric="runs"
        onSeriesSelect={rs.fn()}
      />,
    );

    expect(screen.getByText("Agent owner")).toBeTruthy();
  });
});
