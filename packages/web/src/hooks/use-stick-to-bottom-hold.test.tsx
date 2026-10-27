// @rstest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { HOLD_STICK_EVENT, useStickToBottom } from "./use-stick-to-bottom";

let observers: Array<() => void> = [];
let frames: Array<() => void> = [];
const resize = () => act(() => observers.forEach((callback) => callback()));
const runFrames = () =>
  act(() => {
    // Two frames: the second is scheduled by the first.
    for (let round = 0; round < 3; round += 1) {
      const pending = frames;
      frames = [];
      pending.forEach((callback) => callback());
    }
  });

beforeEach(() => {
  observers = [];
  frames = [];
  rs.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  rs.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

/** A chat pinned to the bottom of a 2000px transcript in a 500px scroller. */
function pinnedChat() {
  const scrollTo = rs.fn();
  let state: { isAtBottom: boolean } = { isAtBottom: true };
  function Chat() {
    const stick = useStickToBottom();
    state = stick;
    return (
      <div
        data-testid="scroller"
        ref={(node) => {
          if (node) {
            Object.defineProperty(node, "scrollHeight", { configurable: true, value: 2000 });
            Object.defineProperty(node, "clientHeight", { configurable: true, value: 500 });
            node.scrollTo = scrollTo;
          }
          stick.scrollRef(node);
        }}
      >
        <div data-testid="content" ref={stick.contentRef}>
          <button type="button">Show full text</button>
        </div>
      </div>
    );
  }
  const view = render(<Chat />);
  const scroller = view.getByTestId("scroller");
  let top = 1500;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  return {
    scrollTo,
    scroller,
    press: () =>
      act(() => {
        view
          .getByRole("button")
          .dispatchEvent(new CustomEvent(HOLD_STICK_EVENT, { bubbles: true }));
      }),
    isAtBottom: () => state.isAtBottom,
  };
}

describe("a control that holds the reading position", () => {
  it("is re-pinned by a resize when nothing holds it", () => {
    const chat = pinnedChat();
    resize();
    expect(chat.scrollTo).toHaveBeenCalled();
  });

  it("is not re-pinned by the resize it causes", () => {
    const chat = pinnedChat();
    chat.press();

    resize();

    expect(chat.scrollTo).not.toHaveBeenCalled();
  });

  it("is not snapped back to the bottom by the scroll it makes", () => {
    const chat = pinnedChat();
    chat.press();

    chat.scroller.scrollTop = 1100;
    act(() => {
      chat.scroller.dispatchEvent(new Event("scroll"));
    });

    expect(chat.scrollTo).not.toHaveBeenCalled();
  });

  it("leaves the view unpinned when it ended away from the bottom", () => {
    const chat = pinnedChat();
    chat.press();
    chat.scroller.scrollTop = 1100;
    runFrames();
    expect(chat.isAtBottom()).toBe(false);

    resize();

    expect(chat.scrollTo).not.toHaveBeenCalled();
  });

  it("pins again when it ended at the bottom", () => {
    const chat = pinnedChat();
    chat.press();
    runFrames();
    expect(chat.isAtBottom()).toBe(true);

    resize();

    expect(chat.scrollTo).toHaveBeenCalled();
  });
});
