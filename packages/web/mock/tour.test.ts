// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, renderHook } from "@testing-library/react";
import { setActiveSession, setToolsCollapsed } from "../src/pages/free/use-free-cells";
import { useStickToBottom } from "./use-tour-scroll";
import { useFreeCells } from "./use-tour-workspace";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  setActiveSession(null);
});

describe("guided mock presentation", () => {
  it("keeps the guided transcript at the start when session loading requests the bottom", () => {
    window.history.replaceState(null, "", "/chat/mock-chat-build-app?tour=build");
    const scroll = rs.spyOn(window, "scrollTo").mockImplementation(() => {});
    const { result } = renderHook(() => useStickToBottom());
    act(() => result.current.scrollToBottom("auto"));
    expect(result.current.isAtBottom).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("keeps normal mock chats able to resume following new messages", () => {
    window.history.replaceState(null, "", "/chat/mock-chat-build-app");
    const scroll = rs.spyOn(window, "scrollTo").mockImplementation(() => {});
    const { result } = renderHook(() => useStickToBottom({ initialStuck: false }));
    act(() => result.current.scrollToBottom("auto"));
    expect(result.current.isAtBottom).toBe(true);
    expect(scroll).toHaveBeenCalled();
  });

  it("hides the guided tools panel without changing the saved workspace preference", () => {
    setActiveSession("mock-chat-build-app");
    setToolsCollapsed(false);
    const before = localStorage.getItem("rome:tool-view:mock-chat-build-app");
    window.history.replaceState(null, "", "/chat/mock-chat-build-app?tour=build");
    const { result, rerender } = renderHook(() => useFreeCells());
    expect(result.current.toolView.collapsed).toBe(true);
    expect(localStorage.getItem("rome:tool-view:mock-chat-build-app")).toBe(before);
    window.history.replaceState(null, "", "/chat/mock-chat-build-app");
    rerender();
    expect(result.current.toolView.collapsed).toBe(false);
  });
});
