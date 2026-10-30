// @rstest-environment jsdom
import { Activity, useLayoutEffect, useRef, useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { useOlderMessages } from "./use-older-messages";

const api = rs.hoisted(() => ({ resolve: [] as Array<(page: unknown) => void> }));
rs.mock("@/lib/chat-api", () => ({
  listSessionMessagePage: () => new Promise((resolve) => api.resolve.push(resolve)),
}));

const writes: number[] = [];
let hiddenNow = false;
let top = 0;
let height = 2000;

beforeEach(() => {
  rs.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  hiddenNow = false;
  top = 0;
  height = 2000;
  writes.length = 0;
  api.resolve.length = 0;
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

let loadOlder: (id: string) => Promise<void> = async () => {};

/** The hooks in the order Chat calls them, the chat's own `shown` flag included. */
function Chat() {
  const stick = useStickToBottom({ initialStuck: false });
  const shown = useRef(true);
  useLayoutEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const older = useOlderMessages("s", {
    pageTurns: 30,
    scroller: scrollerEl,
    pinned: stick.isAtBottom,
    setMessages: () => {},
    shown,
  });
  const { setCursor } = older;
  useLayoutEffect(() => setCursor("s", "c1"), [setCursor]);
  loadOlder = older.loadOlder;
  return (
    <div
      ref={(node) => {
        if (node && !Object.hasOwn(node, "scrollTop")) {
          // A hidden scroller has no box: everything reads 0, as in a browser.
          Object.defineProperty(node, "clientHeight", {
            configurable: true,
            get: () => (hiddenNow ? 0 : 500),
          });
          Object.defineProperty(node, "scrollHeight", {
            configurable: true,
            get: () => (hiddenNow ? 0 : height),
          });
          Object.defineProperty(node, "scrollTop", {
            configurable: true,
            get: () => (hiddenNow ? 0 : top),
            set: (value: number) => {
              writes.push(value);
              top = value;
            },
          });
          node.scrollTo = ((position: ScrollToOptions) => {
            top = position.top ?? top;
          }) as typeof node.scrollTo;
        }
        stick.scrollRef(node);
        if (node) setScrollerEl(node);
      }}
    >
      <div ref={stick.contentRef} />
    </div>
  );
}
const page = (mode: "visible" | "hidden") => (
  <Activity mode={mode}>
    <Chat />
  </Activity>
);

describe("an older page that lands while the chat is hidden", () => {
  it("leaves the reader where the show puts them, and is asked for again once shown", async () => {
    const view = render(page("visible"));
    // The reader scrolled up to 640.
    act(() => {
      window.dispatchEvent(new Event("wheel"));
      top = 640;
      view.container.firstElementChild?.dispatchEvent(new Event("scroll"));
    });
    let first!: Promise<void>;
    act(() => {
      first = loadOlder("s");
    });
    hiddenNow = true;
    view.rerender(page("hidden"));
    top = 0;

    await act(async () => {
      api.resolve[0]?.({ messages: [], nextCursor: "c0" });
      await first;
    });
    hiddenNow = false;
    height = 3000;
    view.rerender(page("visible"));
    // Only the restore wrote: no anchor from the zero scrollTop and scrollHeight read while hidden.
    expect(top).toBe(640);
    expect(writes).toEqual([640]);

    // The page was dropped with its cursor kept, so a request now is a fresh one.
    let second!: Promise<void>;
    act(() => {
      second = loadOlder("s");
    });
    expect(api.resolve).toHaveLength(2);
    await act(async () => {
      api.resolve[1]?.({ messages: [], nextCursor: null });
      await second;
    });
  });
});
