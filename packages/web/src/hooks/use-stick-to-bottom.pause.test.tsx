// @rstest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, rs } from "@rstest/core";
import { useStickToBottom } from "./use-stick-to-bottom";

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

it("leaves a covered main transcript's position and stickiness unchanged until future growth", () => {
  const callbacks: (() => void)[] = [];
  rs.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  const paused = { current: false };
  const scroller = document.createElement("div");
  Object.defineProperties(scroller, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 300 },
  });
  scroller.scrollTo = rs.fn();
  const { result } = renderHook(() => useStickToBottom({ paused }));
  act(() => result.current.scrollRef(scroller));
  act(() => callbacks.forEach((callback) => callback()));
  expect(scroller.scrollTo).toHaveBeenCalled();
  rs.mocked(scroller.scrollTo).mockClear();
  paused.current = true;
  act(() => {
    result.current.scrollToBottom();
    callbacks.forEach((callback) => callback());
  });
  expect(scroller.scrollTo).not.toHaveBeenCalled();
  expect(result.current.isAtBottom).toBe(true);
  paused.current = false;
  expect(scroller.scrollTo).not.toHaveBeenCalled();
  act(() => callbacks.forEach((callback) => callback()));
  expect(scroller.scrollTo).toHaveBeenCalled();
});
