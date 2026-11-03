// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  beginPending,
  expirePending,
  failPending,
  markUnchanged,
  PENDING_TIMEOUT_MS,
  resetPending,
  settlePending,
  usePendingActions,
} from "./task-pending";

function Probe() {
  const pending = usePendingActions();
  return <p data-testid="phase">{pending.get("t1")?.phase ?? "none"}</p>;
}
const phase = () => screen.getByTestId("phase").textContent;

beforeEach(() => resetPending());
afterEach(() => {
  cleanup();
  rs.useRealTimers();
});

describe("pending panel actions", () => {
  it("waits for a write to the row later than the one the button was pressed on", () => {
    render(<Probe />);
    act(() => beginPending("t1", "stop", 1_000, "input-1"));
    expect(phase()).toBe("pending");
    act(() => settlePending({ id: "t1", updatedAt: 1_000 }));
    expect(phase()).toBe("pending");
    act(() => settlePending({ id: "other", updatedAt: 5_000 }));
    expect(phase()).toBe("pending");
    act(() => settlePending({ id: "t1", updatedAt: 1_001 }));
    expect(phase()).toBe("none");
  });

  it("shows a press the turn that took it in left alone, only while it is pending", () => {
    render(<Probe />);
    act(() => beginPending("t1", "archive", 1_000, "input-1"));
    act(() => markUnchanged("t1"));
    expect(phase()).toBe("unchanged");
    act(() => settlePending({ id: "t1", updatedAt: 2_000 }));
    expect(phase()).toBe("none");
    // A press already settled stays settled.
    act(() => markUnchanged("t1"));
    expect(phase()).toBe("none");
  });

  it("times out after 60 s without a write, on its own clock", () => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2026-10-29T12:00:00Z"));
    render(<Probe />);
    act(() => beginPending("t1", "stop", 1_000, "input-1"));
    act(() => {
      rs.advanceTimersByTime(PENDING_TIMEOUT_MS - 1_000);
    });
    expect(phase()).toBe("pending");
    act(() => {
      rs.advanceTimersByTime(1_000);
    });
    expect(phase()).toBe("timeout");
  });

  it("keeps a timed-out press until the row is written or the press repeats", () => {
    render(<Probe />);
    act(() => beginPending("t1", "stop", 1_000, "input-1", 0));
    act(() => expirePending(PENDING_TIMEOUT_MS));
    expect(phase()).toBe("timeout");
    act(() => beginPending("t1", "stop", 1_000, "input-1"));
    expect(phase()).toBe("pending");
    act(() => failPending("t1"));
    expect(phase()).toBe("failed");
  });
});
