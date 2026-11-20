// @rstest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { nextReveal, REVEAL_CHARS_PER_SECOND, VoiceInputSpokenText } from "./VoiceInputSpokenText";

describe("revealing spoken text", () => {
  it("shows as many more characters as the budget allows", () => {
    expect(nextReveal("buy", "buy milk", 2)).toBe("buy m");
  });

  it("stops at the end of the text heard so far", () => {
    expect(nextReveal("buy mi", "buy milk", 5)).toBe("buy milk");
  });

  it("puts a corrected word in the positions already shown at once", () => {
    expect(nextReveal("buy silk", "buy milk", 0)).toBe("buy milk");
    expect(nextReveal("buy silk", "buy", 0)).toBe("buy");
  });

  it("never falls more than a second behind", () => {
    const goal = "x".repeat(REVEAL_CHARS_PER_SECOND + 30);
    expect(nextReveal("", goal, 1)).toHaveLength(30);
  });

  it("never takes characters back for a negative budget", () => {
    expect(nextReveal("", "buy milk", -1)).toBe("");
    expect(nextReveal("buy", "buy milk", -1)).toBe("buy");
  });

  it("never splits an emoji", () => {
    expect(nextReveal("ok ", "ok 😀!", 1)).toBe("ok 😀");
  });
});

describe("the spoken text over the field", () => {
  afterEach(() => {
    cleanup();
    rs.unstubAllGlobals();
  });

  it("swaps a correction into characters already shown without fading them in again", () => {
    // Frames run when the test says so, each a second apart.
    const frames: FrameRequestCallback[] = [];
    let now = 0;
    rs.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    rs.stubGlobal("cancelAnimationFrame", () => {});
    const frame = () =>
      act(() => {
        now += 1000;
        for (const callback of frames.splice(0)) callback(now);
      });
    rs.spyOn(performance, "now").mockImplementation(() => now);

    const textareaRef = createRef<HTMLTextAreaElement>();
    const field = (value: string) => (
      <div className="relative">
        <textarea ref={textareaRef} value={value} readOnly />
        <VoiceInputSpokenText
          textareaRef={textareaRef}
          preview={{ value, start: 0, end: value.length }}
        />
      </div>
    );
    const { container, rerender } = render(field("buy silk"));
    // The first frame starts the clock; the next has a second's budget.
    frame();
    frame();
    const copy = () => container.querySelector("[data-voice-input-spoken-text]");
    expect(copy()?.textContent).toBe("buy silk");
    const before = Array.from(copy()?.querySelectorAll("span") ?? []);

    rerender(field("buy milk"));
    // No frame has run, so no budget: the correction still shows at once.
    act(() => {
      for (const callback of frames.splice(0)) callback(now);
    });
    expect(copy()?.textContent).toBe("buy milk");
    const after = Array.from(copy()?.querySelectorAll("span") ?? []);
    // The same elements, so their fade-in does not run again.
    expect(after).toHaveLength(before.length);
    expect(after.every((span, i) => span === before[i])).toBe(true);
  });

  /**
   * Lays out a copy as jsdom cannot: each spoken character sits 1,000 px down
   * a copy whose box is 240 px tall, so the newest words show at a scroll of
   * 780. Scroll positions are kept as set. Returns the copy, a way to report
   * a resize, and the undo for the stubs.
   */
  function renderLaidOut(value: string) {
    const resizes: ResizeObserverCallback[] = [];
    rs.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizes.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    rs.stubGlobal("matchMedia", () => ({ matches: true }));
    const scroll = new WeakMap<Element, number>();
    const geometry: Record<
      string,
      { get: (el: HTMLElement) => unknown; set?: (el: HTMLElement, value: number) => void }
    > = {
      offsetTop: { get: (el) => (el.tagName === "SPAN" ? 1000 : 0) },
      offsetHeight: { get: (el) => (el.tagName === "SPAN" ? 20 : 240) },
      clientHeight: { get: () => 240 },
      offsetParent: { get: (el) => el.parentElement },
      scrollTop: {
        get: (el) => scroll.get(el) ?? 0,
        set: (el, top) => scroll.set(el, top),
      },
    };
    const saved = Object.keys(geometry).map(
      (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const,
    );
    for (const [name, { get, set }] of Object.entries(geometry)) {
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get() {
          return get(this);
        },
        set(top: number) {
          set?.(this, top);
        },
      });
    }
    const restore = () => {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    };
    const textareaRef = createRef<HTMLTextAreaElement>();
    const { container } = render(
      <div className="relative">
        <textarea ref={textareaRef} value="" readOnly />
        <VoiceInputSpokenText
          textareaRef={textareaRef}
          preview={{ value, start: 0, end: value.length }}
        />
      </div>,
    );
    const copy = container.querySelector("[data-voice-input-spoken-text]") as HTMLElement;
    const resize = () =>
      act(() => {
        for (const resized of resizes) resized([], {} as ResizeObserver);
      });
    return { copy, resize, restore };
  }

  it("keeps the newest spoken words in view after the field's box changes", () => {
    const { copy, resize, restore } = renderLaidOut("buy milk");
    try {
      copy.scrollTop = 0;
      resize();
      expect(copy.scrollTop).toBe(780);
    } finally {
      restore();
    }
  });

  it("stays where the guardian scrolled back to, until they scroll to the newest words", () => {
    const { copy, resize, restore } = renderLaidOut("buy milk");
    try {
      copy.scrollTop = 100;
      fireEvent.scroll(copy);
      resize();
      expect(copy.scrollTop).toBe(100);

      copy.scrollTop = 780;
      fireEvent.scroll(copy);
      copy.scrollTop = 500;
      resize();
      expect(copy.scrollTop).toBe(780);
    } finally {
      restore();
    }
  });
});
