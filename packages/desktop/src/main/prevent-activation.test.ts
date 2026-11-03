import { describe, expect, it } from "@rstest/core";
import { preventActivation, type ObjcRuntime } from "./prevent-activation";

const VIEW = Buffer.alloc(8);
const NS_WINDOW = { id: "nswindow" };

function fakeRuntime(options: { nsWindow?: unknown; responds: boolean }) {
  const sent: { target: unknown; selector: string; value: boolean }[] = [];
  const runtime: ObjcRuntime = {
    windowOfView: (view) => {
      expect(view).toBe(VIEW);
      return "nsWindow" in options ? options.nsWindow : NS_WINDOW;
    },
    respondsToSelector: () => options.responds,
    sendBool: (target, selector, value) => {
      sent.push({ target, selector, value });
    },
  };
  return { runtime, sent };
}

const win = { getNativeWindowHandle: () => VIEW };

describe("preventActivation", () => {
  it("sets the window's prevents-activation flag", () => {
    const { runtime, sent } = fakeRuntime({ responds: true });
    expect(preventActivation(win, () => runtime)).toBe(true);
    expect(sent).toEqual([{ target: NS_WINDOW, selector: "_setPreventsActivation:", value: true }]);
  });

  it("sends nothing when AppKit no longer has the method", () => {
    const { runtime, sent } = fakeRuntime({ responds: false });
    expect(preventActivation(win, () => runtime)).toBe(false);
    expect(sent).toEqual([]);
  });

  it("sends nothing when the view has no window", () => {
    const { runtime, sent } = fakeRuntime({ nsWindow: null, responds: true });
    expect(preventActivation(win, () => runtime)).toBe(false);
    expect(sent).toEqual([]);
  });
});
