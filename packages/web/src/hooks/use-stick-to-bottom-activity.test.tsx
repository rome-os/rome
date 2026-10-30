// @rstest-environment jsdom
import { Activity } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { useStickToBottom } from "./use-stick-to-bottom";

beforeEach(() => {
  rs.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

/** A 2000px transcript in a 500px scroller, which like a browser's forgets its offset when hidden. */
function chat(options: { pinned: boolean; startAt: number }) {
  let top = options.startAt;
  function Scroller() {
    const stick = useStickToBottom({ initialStuck: options.pinned });
    return (
      <div
        ref={(node) => {
          if (node && !Object.hasOwn(node, "scrollTop")) {
            node.scrollTo = ((position: ScrollToOptions) => {
              top = position.top ?? top;
            }) as typeof node.scrollTo;
            Object.defineProperty(node, "scrollHeight", { configurable: true, value: 2000 });
            Object.defineProperty(node, "clientHeight", { configurable: true, value: 500 });
            Object.defineProperty(node, "scrollTop", {
              configurable: true,
              get: () => top,
              set: (value: number) => {
                top = value;
              },
            });
          }
          stick.scrollRef(node);
        }}
      >
        <div ref={stick.contentRef} />
        <output>{String(stick.isAtBottom)}</output>
      </div>
    );
  }
  const page = (mode: "visible" | "hidden") => (
    <Activity mode={mode}>
      <Scroller />
    </Activity>
  );
  const view = render(page("visible"));
  return {
    top: () => top,
    pinned: () => view.container.querySelector("output")?.textContent,
    hide: () => {
      view.rerender(page("hidden"));
      // `display: none` took the scroller's box, and its offset with it.
      top = 0;
    },
    show: () => view.rerender(page("visible")),
    /** The browser moves the scroller without a scroll event, as it does when the page around it reflows. */
    reflow: (to: number) => {
      top = to;
    },
    /** The reader drags the scroller to `to`: a gesture, then the scroll it causes. */
    drag: (to: number) =>
      act(() => {
        window.dispatchEvent(new Event("wheel"));
        top = to;
        view.container.firstElementChild?.dispatchEvent(new Event("scroll"));
      }),
  };
}

describe("a scroller hidden by an Activity", () => {
  it("is put back where the reader left it", () => {
    const reader = chat({ pinned: false, startAt: 640 });

    reader.hide();
    expect(reader.top()).toBe(0);
    reader.show();

    expect(reader.top()).toBe(640);
    expect(reader.pinned()).toBe("false");
  });

  it("goes to the bottom when the reader was pinned there", () => {
    const reader = chat({ pinned: true, startAt: 1500 });

    reader.hide();
    reader.show();

    expect(reader.top()).toBe(2000);
    expect(reader.pinned()).toBe("true");
  });

  it("is put back at the offset the reader had, not one the page's reflow moved it to", () => {
    const reader = chat({ pinned: false, startAt: 0 });
    reader.drag(640);
    // The commit that hides the chat also changes the page around it.
    reader.reflow(520);

    reader.hide();
    reader.show();

    expect(reader.top()).toBe(640);
  });

  it("lets the reader scroll up the moment it is shown again", () => {
    const reader = chat({ pinned: true, startAt: 2000 });
    reader.hide();
    reader.show();
    expect(reader.top()).toBe(2000);

    // No scroll came between the show and this one, so the first has nothing
    // to compare with; it still counts as the move up it is.
    reader.drag(1200);

    expect(reader.top()).toBe(1200);
    expect(reader.pinned()).toBe("false");
  });
});
