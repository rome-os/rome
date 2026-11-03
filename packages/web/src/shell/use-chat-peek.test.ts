// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, renderHook } from "@testing-library/react";
import { PEEK_CLOSE_DELAY_MS, PEEK_OPEN_DELAY_MS, useChatPeek } from "./use-chat-peek";

function pointerMove(clientX: number, pointerType = "mouse") {
  const event = new MouseEvent("pointermove", { clientX, bubbles: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  act(() => {
    window.dispatchEvent(event);
  });
}

// The panel's right edge sits at 320px, as rail (64) + list (256) do.
const panel = {
  current: { getBoundingClientRect: () => ({ right: 320 }) } as unknown as HTMLElement,
};

function advance(ms: number) {
  act(() => {
    rs.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  rs.useFakeTimers();
});

afterEach(() => {
  rs.useRealTimers();
});

describe("useChatPeek", () => {
  it("opens after the pointer rests on the Chat tile, not on a pass across it", () => {
    const { result } = renderHook(() => useChatPeek(true, "/chat", panel));

    act(() => result.current.tile.onPointerEnter());
    act(() => result.current.tile.onPointerLeave());
    advance(PEEK_OPEN_DELAY_MS);
    expect(result.current.open).toBe(false);

    act(() => result.current.tile.onPointerEnter());
    advance(PEEK_OPEN_DELAY_MS - 1);
    expect(result.current.open).toBe(false);
    advance(1);
    expect(result.current.open).toBe(true);
  });

  it("opens at once when a mouse reaches the window's left edge", () => {
    const { result } = renderHook(() => useChatPeek(true, "/chat", panel));

    pointerMove(40);
    pointerMove(0, "touch");
    expect(result.current.open).toBe(false);

    pointerMove(2);
    expect(result.current.open).toBe(true);
  });

  it("stays open over the rail and the panel and closes a moment after the pointer passes it", () => {
    const { result } = renderHook(() => useChatPeek(true, "/chat", panel));
    pointerMove(0);

    // Overshooting the edge and coming straight back keeps it.
    pointerMove(400);
    advance(PEEK_CLOSE_DELAY_MS - 50);
    pointerMove(300);
    advance(PEEK_CLOSE_DELAY_MS);
    expect(result.current.open).toBe(true);

    // Leaving the Chat tile for the panel is not leaving the sidebar.
    act(() => result.current.tile.onPointerLeave());
    pointerMove(30);
    advance(PEEK_CLOSE_DELAY_MS);
    expect(result.current.open).toBe(true);

    pointerMove(600);
    advance(PEEK_CLOSE_DELAY_MS);
    expect(result.current.open).toBe(false);
  });

  it("stays open past its edge while a menu opened from it is open", () => {
    const { result } = renderHook(() => useChatPeek(true, "/chat", panel));
    pointerMove(0);
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);

    pointerMove(600);
    advance(PEEK_CLOSE_DELAY_MS * 2);
    expect(result.current.open).toBe(true);

    menu.remove();
    pointerMove(600);
    advance(PEEK_CLOSE_DELAY_MS);
    expect(result.current.open).toBe(false);
  });

  it("closes when a chat is opened from it", () => {
    const { result, rerender } = renderHook(({ path }) => useChatPeek(true, path, panel), {
      initialProps: { path: "/chat" },
    });
    pointerMove(0);
    expect(result.current.open).toBe(true);

    rerender({ path: "/chat/abc" });
    expect(result.current.open).toBe(false);
  });

  it("never opens while disabled, and closes when it becomes disabled", () => {
    const { result, rerender } = renderHook(({ enabled }) => useChatPeek(enabled, "/chat", panel), {
      initialProps: { enabled: false },
    });
    pointerMove(0);
    act(() => result.current.tile.onPointerEnter());
    advance(PEEK_OPEN_DELAY_MS);
    expect(result.current.open).toBe(false);

    rerender({ enabled: true });
    pointerMove(0);
    expect(result.current.open).toBe(true);
    rerender({ enabled: false });
    expect(result.current.open).toBe(false);
  });
});
