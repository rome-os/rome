// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, renderHook } from "@testing-library/react";
import { TOUR_PROMPT, useTourTyping } from "./use-tour-typing";

beforeEach(() => {
  rs.useFakeTimers();
  window.history.replaceState(null, "", "/chat?tour=chat");
  rs.spyOn(document, "referrer", "get").mockReturnValue("http://localhost:3100/");
  rs.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(() => {
  cleanup();
  rs.useRealTimers();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function control(
  active: boolean,
  progress = 0,
  origin = "http://localhost:3100",
  source: Window | null = window,
) {
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin,
        source,
        data: { type: "rome:tour-typing", active, progress },
      }),
    ),
  );
}

describe("tour prompt typing", () => {
  it("maps scroll position to prompt text in both directions without continuing on its own", () => {
    const insert = rs.fn();
    renderHook(() => useTourTyping(insert));
    for (const progress of [0, 0.25, 0.8, 1, 0.8, 0.25, 0]) {
      control(true, progress);
      expect(insert).toHaveBeenLastCalledWith(
        TOUR_PROMPT.slice(0, Math.floor(progress * TOUR_PROMPT.length)),
      );
    }
    const calls = insert.mock.calls.length;
    act(() => rs.advanceTimersByTime(1000));
    expect(insert.mock.calls.length).toBe(calls);
    expect(rs.getTimerCount()).toBe(0);
  });

  it("clamps overscroll and restores the latest position while hidden", () => {
    const insert = rs.fn();
    renderHook(() => useTourTyping(insert));
    control(true, 2);
    expect(insert).toHaveBeenLastCalledWith(TOUR_PROMPT);
    control(false, -1);
    expect(insert).toHaveBeenLastCalledWith("");
    control(true, Number.NaN);
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("ignores messages from another origin or window", () => {
    const insert = rs.fn();
    renderHook(() => useTourTyping(insert));
    control(true, 1, "https://unrelated.example");
    control(true, 1, "http://localhost:3100", null);
    expect(insert).not.toHaveBeenCalled();
  });

  it("preserves scroll position with reduced motion", () => {
    rs.stubGlobal("matchMedia", () => ({ matches: true }));
    const insert = rs.fn();
    renderHook(() => useTourTyping(insert));
    control(true, 0.5);
    expect(insert).toHaveBeenLastCalledWith(
      TOUR_PROMPT.slice(0, Math.floor(TOUR_PROMPT.length / 2)),
    );
    expect(rs.getTimerCount()).toBe(0);
  });

  it("leaves ordinary mock chats untouched", () => {
    window.history.replaceState(null, "", "/chat");
    const insert = rs.fn();
    renderHook(() => useTourTyping(insert));
    control(true, 1);
    expect(insert).not.toHaveBeenCalled();
  });
});
