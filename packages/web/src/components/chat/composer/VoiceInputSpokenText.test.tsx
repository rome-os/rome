// @rstest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
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

  it("keeps the newest spoken words in view after the field's box changes", () => {
    // jsdom lays nothing out: each spoken character sits 1,000 px down a copy
    // whose box is 240 px tall, and scroll positions are kept as set.
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
    const geometry = {
      offsetTop: { get: (el: HTMLElement) => (el.tagName === "SPAN" ? 1000 : 0) },
      offsetHeight: { get: (el: HTMLElement) => (el.tagName === "SPAN" ? 20 : 240) },
      clientHeight: { get: () => 240 },
      offsetParent: { get: (el: HTMLElement) => el.parentElement },
      scrollTop: {
        get: (el: HTMLElement) => scroll.get(el) ?? 0,
        set: (el: HTMLElement, value: number) => scroll.set(el, value),
      },
    };
    const saved = Object.keys(geometry).map(
      (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const,
    );
    for (const [name, { get, set }] of Object.entries(geometry) as [
      string,
      { get: (el: HTMLElement) => unknown; set?: (el: HTMLElement, value: number) => void },
    ][]) {
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get() {
          return get(this);
        },
        set(value: number) {
          set?.(this, value);
        },
      });
    }
    try {
      const textareaRef = createRef<HTMLTextAreaElement>();
      const value = "buy milk";
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
      act(() => {
        for (const resized of resizes) resized([], {} as ResizeObserver);
      });
      expect(copy.scrollTop).toBe(780);
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    }
  });
});
