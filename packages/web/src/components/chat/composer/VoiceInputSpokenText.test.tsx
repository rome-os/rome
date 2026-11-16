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
          value={value}
          spoken={{ start: 0, end: value.length }}
        />
      </div>
    );
    const { container, rerender } = render(field("buy silk"));
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
});
