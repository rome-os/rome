// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useStickToBottom } from "./use-tour-scroll";

let resized: () => void;
beforeEach(() => {
  window.history.replaceState(null, "", "/chat/mock-chat-build-app?tour=build");
  rs.spyOn(document, "referrer", "get").mockReturnValue("http://localhost:3100/");
  rs.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function control(
  progress: number,
  origin = "http://localhost:3100",
  source: Window | null = window,
) {
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin,
        source,
        data: { type: "rome:tour-scroll", progress },
      }),
    ),
  );
}

describe("scroll-linked build conversation", () => {
  it("scrubs both ways and stays at the same progress when the side panel reflows the chat", () => {
    const container = document.createElement("div");
    const content = document.createElement("div");
    container.append(content);
    let height = 1400;
    Object.defineProperties(container, {
      clientHeight: { value: 400 },
      scrollHeight: { get: () => height },
    });
    container.scrollTo = rs.fn();
    const { result } = renderHook(() => useStickToBottom());
    act(() => {
      result.current.scrollRef(container);
      result.current.contentRef(content);
    });
    for (const progress of [0, 0.5, 1, 0.5, 0]) {
      control(progress);
      expect(container.scrollTo).toHaveBeenLastCalledWith({
        top: progress * 1000,
        behavior: "instant",
      });
      expect(result.current.isAtBottom).toBe(progress === 1);
    }
    control(1);
    height = 2400;
    act(() => resized());
    expect(container.scrollTo).toHaveBeenLastCalledWith({ top: 2000, behavior: "instant" });
    control(0.5);
    expect(container.scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: "instant" });
    const calls = rs.mocked(container.scrollTo).mock.calls.length;
    control(0, "https://unrelated.example");
    control(0, "http://localhost:3100", null);
    control(Number.NaN);
    expect(container.scrollTo).toHaveBeenCalledTimes(calls);
  });

  it("replays progress after a late transcript mount and handles a window scroller", () => {
    const scroll = rs.spyOn(window, "scrollTo").mockImplementation(() => {});
    const post = rs.spyOn(window.parent, "postMessage").mockImplementation((message) => {
      if (message.type === "rome:tour-scroll-ready") control(0.5);
    });
    const { result } = renderHook(() => useStickToBottom());
    expect(post).not.toHaveBeenCalled();
    const height = rs
      .spyOn(document.documentElement, "scrollHeight", "get")
      .mockReturnValue(window.innerHeight + 1000);
    act(() => result.current.contentRef(document.createElement("div")));
    expect(post).toHaveBeenCalledWith({ type: "rome:tour-scroll-ready" }, "http://localhost:3100");
    expect(scroll).toHaveBeenLastCalledWith({ top: 500, behavior: "instant" });
    height.mockReturnValue(window.innerHeight + 2000);
    act(() => resized());
    expect(scroll).toHaveBeenLastCalledWith({ top: 1000, behavior: "instant" });
  });
});
