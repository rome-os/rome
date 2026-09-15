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
  it("types the build conversation's exact prompt and pauses when hidden", () => {
    const insert = rs.fn();
    renderHook(() => useTourTyping(insert));
    act(() => rs.advanceTimersByTime(1000));
    expect(insert).not.toHaveBeenCalled();
    control(true);
    act(() => rs.advanceTimersByTime(120));
    expect(insert.mock.calls.at(-1)?.[0]).toBe(TOUR_PROMPT.slice(0, 12));
    control(false);
    const calls = insert.mock.calls.length;
    act(() => rs.advanceTimersByTime(1000));
    expect(insert.mock.calls.length).toBe(calls);
    control(true, 1);
    expect(insert.mock.calls.at(-1)?.[0]).toBe(TOUR_PROMPT);
  });

  it("ignores messages from another origin or window", () => {
    const insert = rs.fn();
    renderHook(() => useTourTyping(insert));
    control(true, 1, "https://unrelated.example");
    control(true, 1, "http://localhost:3100", null);
    expect(insert).not.toHaveBeenCalled();
  });

  it("shows the entire prompt immediately with reduced motion", () => {
    rs.stubGlobal("matchMedia", () => ({ matches: true }));
    const insert = rs.fn();
    renderHook(() => useTourTyping(insert));
    control(true);
    expect(insert).toHaveBeenLastCalledWith(TOUR_PROMPT);
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
