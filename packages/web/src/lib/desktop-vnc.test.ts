import { describe, expect, it, rs } from "@rstest/core";
import {
  buildPasteKeySequence,
  computeFitTransform,
  computeGestureTransform,
  createDeferredPasteController,
  isPasteShortcut,
} from "../../public/js/desktop-vnc.js";

describe("buildPasteKeySequence", () => {
  it("normalizes Windows newlines into Enter key presses", () => {
    expect(buildPasteKeySequence("hello\r\nworld")).toEqual([
      { keysym: 0x68 },
      { keysym: 0x65 },
      { keysym: 0x6c },
      { keysym: 0x6c },
      { keysym: 0x6f },
      { keysym: 0xff0d, code: "Enter" },
      { keysym: 0x77 },
      { keysym: 0x6f },
      { keysym: 0x72 },
      { keysym: 0x6c },
      { keysym: 0x64 },
    ]);
  });

  it("maps tabs and Unicode text to remote keysyms", () => {
    expect(buildPasteKeySequence("A\t中🙂")).toEqual([
      { keysym: 0x41 },
      { keysym: 0xff09, code: "Tab" },
      { keysym: 0x01004e2d },
      { keysym: 0x0101f642 },
    ]);
  });
});

describe("isPasteShortcut", () => {
  it("matches plain Cmd/Ctrl+V and ignores shifted variants", () => {
    expect(isPasteShortcut(createKeyEvent({ key: "v", metaKey: true }))).toBe(true);
    expect(isPasteShortcut(createKeyEvent({ key: "V", ctrlKey: true }))).toBe(true);
    expect(isPasteShortcut(createKeyEvent({ key: "v", metaKey: true, shiftKey: true }))).toBe(
      false,
    );
  });
});

describe("createDeferredPasteController", () => {
  it("waits until modifiers are released before sending pasted text", async () => {
    let resolveClipboardText = () => {};
    const readClipboardText = rs.fn(
      () =>
        new Promise((resolve) => {
          resolveClipboardText = () => resolve("PA");
        }),
    );
    const onPasteText = rs.fn();
    const onPasteError = rs.fn();
    const controller = createDeferredPasteController({
      readClipboardText,
      onPasteText,
      onPasteError,
    });

    const keyDownEvent = createKeyEvent({ key: "v", metaKey: true });
    expect(controller.handleKeyDown(keyDownEvent)).toBe(true);
    expect(keyDownEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(keyDownEvent.stopPropagation).toHaveBeenCalledTimes(1);
    expect(readClipboardText).toHaveBeenCalledTimes(1);

    expect(controller.handleKeyUp(createKeyEvent({ key: "v", metaKey: true }))).toBe(true);
    resolveClipboardText();
    await flushPromises();
    expect(onPasteText).not.toHaveBeenCalled();

    expect(controller.handleKeyUp(createKeyEvent({ key: "Meta", metaKey: false }))).toBe(true);
    await flushPromises();
    expect(onPasteText).toHaveBeenCalledWith("PA", { ctrlKey: false, metaKey: true });
    expect(onPasteError).not.toHaveBeenCalled();
  });

  it("reports an empty clipboard once the paste shortcut fully releases", async () => {
    const onPasteText = rs.fn();
    const onPasteError = rs.fn();
    const controller = createDeferredPasteController({
      readClipboardText: rs.fn().mockResolvedValue(""),
      onPasteText,
      onPasteError,
    });

    controller.handleKeyDown(createKeyEvent({ key: "v", ctrlKey: true }));
    controller.handleKeyUp(createKeyEvent({ key: "v", ctrlKey: true }));
    controller.handleKeyUp(createKeyEvent({ key: "Control", ctrlKey: false }));
    await flushPromises();

    expect(onPasteText).not.toHaveBeenCalled();
    expect(onPasteError).toHaveBeenCalledWith("Local clipboard is empty.");
  });
});

describe("computeFitTransform", () => {
  it("centers content inside a wider frame", () => {
    const t = computeFitTransform({
      frameWidth: 400,
      frameHeight: 800,
      contentWidth: 1280,
      contentHeight: 800,
    });
    expect(t.scale).toBeCloseTo(400 / 1280);
    expect(t.tx).toBeCloseTo(0);
    expect(t.ty).toBeCloseTo((800 - 800 * (400 / 1280)) / 2);
  });

  it("returns identity when sizes are zero", () => {
    expect(
      computeFitTransform({ frameWidth: 0, frameHeight: 0, contentWidth: 0, contentHeight: 0 }),
    ).toEqual({ scale: 1, tx: 0, ty: 0 });
  });
});

describe("computeGestureTransform", () => {
  it("keeps the canvas point under the gesture center fixed during pinch", () => {
    const start = {
      scale: 1,
      tx: 0,
      ty: 0,
      center: { x: 100, y: 100 },
      distance: 100,
    };
    const next = computeGestureTransform({
      start,
      current: { center: { x: 100, y: 100 }, distance: 200 },
      scaleBounds: { min: 0.1, max: 10 },
    });
    expect(next.scale).toBeCloseTo(2);
    // Canvas point under (100, 100) at start = (100, 100). After 2x, that point should still appear at (100, 100).
    const canvasPointX = (100 - next.tx) / next.scale;
    const canvasPointY = (100 - next.ty) / next.scale;
    expect(canvasPointX).toBeCloseTo(100);
    expect(canvasPointY).toBeCloseTo(100);
  });

  it("translates by the gesture center delta when distance is constant", () => {
    const start = {
      scale: 1.5,
      tx: 10,
      ty: 20,
      center: { x: 200, y: 200 },
      distance: 150,
    };
    const next = computeGestureTransform({
      start,
      current: { center: { x: 250, y: 230 }, distance: 150 },
      scaleBounds: { min: 0.1, max: 10 },
    });
    expect(next.scale).toBeCloseTo(1.5);
    expect(next.tx).toBeCloseTo(10 + 50);
    expect(next.ty).toBeCloseTo(20 + 30);
  });

  it("clamps scale to bounds", () => {
    const start = { scale: 1, tx: 0, ty: 0, center: { x: 0, y: 0 }, distance: 100 };
    const tooBig = computeGestureTransform({
      start,
      current: { center: { x: 0, y: 0 }, distance: 10000 },
      scaleBounds: { min: 0.5, max: 3 },
    });
    expect(tooBig.scale).toBeCloseTo(3);
    const tooSmall = computeGestureTransform({
      start,
      current: { center: { x: 0, y: 0 }, distance: 1 },
      scaleBounds: { min: 0.5, max: 3 },
    });
    expect(tooSmall.scale).toBeCloseTo(0.5);
  });
});

function createKeyEvent(overrides = {}) {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: rs.fn(),
    stopPropagation: rs.fn(),
    ...overrides,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}
