import { describe, expect, it, rs } from "@rstest/core";
import {
  computeFitTransform,
  computeGestureTransform,
  createDeferredPasteController,
  createMetaToControlController,
  isApplePlatform,
  isPasteShortcut,
  sendTextAsKeysyms,
} from "./desktop-vnc";

describe("sendTextAsKeysyms", () => {
  it("sends ASCII, Chinese, and every emoji code point in order", () => {
    const rfb = { sendKey: rs.fn() };

    sendTextAsKeysyms(rfb, "A春☀️🐈‍⬛");

    expect(rfb.sendKey.mock.calls).toEqual(
      [..."A春☀️🐈‍⬛"].map((character) => {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined) throw new Error("character has no code point");
        return [codePoint <= 0xff ? codePoint : 0x01000000 | codePoint, null];
      }),
    );
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
  it("sends pasted text when the shortcut key is released", async () => {
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

  it("drops a pending paste when the modifier release is lost outside the iframe", async () => {
    const onPasteText = rs.fn();
    const controller = createDeferredPasteController({
      readClipboardText: rs.fn().mockResolvedValue("STALE_PASTE"),
      onPasteText,
      onPasteError: rs.fn(),
    });

    controller.handleKeyDown(
      createKeyEvent({ key: "Control", code: "ControlLeft", ctrlKey: true }),
    );
    controller.handleKeyDown(createKeyEvent({ key: "v", ctrlKey: true }));
    controller.handleKeyUp(createKeyEvent({ key: "v", ctrlKey: true }));
    await flushPromises();
    controller.cancel();

    controller.handleKeyDown(createKeyEvent({ key: "Control", ctrlKey: true }));
    controller.handleKeyDown(createKeyEvent({ key: "a", ctrlKey: true }));
    controller.handleKeyUp(createKeyEvent({ key: "a", ctrlKey: true }));
    controller.handleKeyUp(createKeyEvent({ key: "Control", ctrlKey: false }));
    await flushPromises();

    expect(onPasteText).not.toHaveBeenCalled();
  });
});

describe("createMetaToControlController", () => {
  it("maps a macOS Meta key hold to one remote Control key hold", () => {
    const rfb = { sendKey: rs.fn() };
    const controller = createMetaToControlController(rfb, true);
    const keyDown = createKeyEvent({ key: "Meta", code: "MetaLeft", metaKey: true });
    const keyUp = createKeyEvent({ key: "Meta", code: "MetaLeft" });

    expect(controller.handleKeyDown(keyDown)).toBe(true);
    expect(controller.handleKeyDown(keyDown)).toBe(true);
    expect(controller.handleKeyUp(keyUp)).toBe(true);
    expect(rfb.sendKey.mock.calls).toEqual([
      [0xffe3, "ControlLeft", true],
      [0xffe3, "ControlLeft", false],
    ]);
  });

  it("maps a macOS chord when the browser omits standalone Meta events", async () => {
    const rfb = { sendKey: rs.fn() };
    const controller = createMetaToControlController(rfb, true);

    expect(
      controller.handleKeyDown(createKeyEvent({ key: "a", code: "KeyA", metaKey: true })),
    ).toBe(false);
    expect(controller.handleKeyUp(createKeyEvent({ key: "a", code: "KeyA", metaKey: true }))).toBe(
      false,
    );
    await flushPromises();

    expect(rfb.sendKey.mock.calls).toEqual([
      [0xffe3, "ControlLeft", true],
      [0xffe3, "ControlLeft", false],
    ]);
  });

  it("releases implicit Control after keydown when the browser omits keyup", async () => {
    const rfb = { sendKey: rs.fn() };
    const controller = createMetaToControlController(rfb, true);

    controller.handleKeyDown(createKeyEvent({ key: "a", code: "KeyA", metaKey: true }));
    expect(rfb.sendKey.mock.calls).toEqual([[0xffe3, "ControlLeft", true]]);

    await flushPromises();
    expect(rfb.sendKey.mock.calls).toEqual([
      [0xffe3, "ControlLeft", true],
      [0xffe3, "ControlLeft", false],
    ]);
  });

  it("recognizes Apple browser platform names", () => {
    expect(isApplePlatform("MacIntel")).toBe(true);
    expect(isApplePlatform("iPhone")).toBe(true);
    expect(isApplePlatform("Linux x86_64")).toBe(false);
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
    code: "",
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
