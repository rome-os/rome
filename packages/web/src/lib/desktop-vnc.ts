interface RemoteKeySender {
  sendKey(keysym: number, code: string | null, down?: boolean): void;
}

interface DesktopRfb extends RemoteKeySender, EventTarget {
  viewOnly: boolean;
  scaleViewport: boolean;
  clipViewport: boolean;
  dragViewport: boolean;
  resizeSession: boolean;
  focus(options?: FocusOptions): void;
  blur(): void;
  disconnect(): void;
  clipboardPasteFrom(text: string): void;
}

export type DesktopRfbConstructor = new (target: Element, url: string) => DesktopRfb;

interface KeyboardEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

interface PasteModifiers {
  ctrlKey: boolean;
  metaKey: boolean;
}

type TimerHandle = ReturnType<typeof setTimeout>;

const PASTE_MODIFIER_KEYS = {
  control: [
    { keysym: 0xffe3, code: "ControlLeft" },
    { keysym: 0xffe4, code: "ControlRight" },
  ],
  meta: [
    { keysym: 0xffe7, code: "MetaLeft" },
    { keysym: 0xffe8, code: "MetaRight" },
    { keysym: 0xffe9, code: "AltLeft" },
    { keysym: 0xffea, code: "AltRight" },
    { keysym: 0xffeb, code: "SuperLeft" },
    { keysym: 0xffec, code: "SuperRight" },
  ],
};

export function sendRemotePasteShortcut(rfb: RemoteKeySender): void {
  rfb.sendKey(0xffe3, "ControlLeft", true);
  rfb.sendKey(0x76, "KeyV", true);
  rfb.sendKey(0x76, "KeyV", false);
  rfb.sendKey(0xffe3, "ControlLeft", false);
}

export function createRemoteClipboardPasteController({
  rfb,
  settleDelay = 100,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: {
  rfb: Pick<DesktopRfb, "clipboardPasteFrom" | "sendKey">;
  settleDelay?: number;
  setTimer?: (handler: () => void, delay: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}) {
  const queue: string[] = [];
  let active = false;
  let settleTimer: TimerHandle | null = null;
  let destroyed = false;

  function startNextPaste() {
    if (destroyed || active || queue.length === 0) {
      return;
    }

    const text = queue.shift();
    if (text === undefined) return;
    active = true;
    rfb.clipboardPasteFrom(text);
    sendRemotePasteShortcut(rfb);
    settleTimer = setTimer(() => {
      settleTimer = null;
      active = false;
      startNextPaste();
    }, settleDelay);
  }

  return {
    paste(text: string) {
      if (!text || destroyed) {
        return;
      }
      queue.push(text);
      startNextPaste();
    },

    destroy() {
      destroyed = true;
      queue.length = 0;
      active = false;
      if (settleTimer !== null) {
        clearTimer(settleTimer);
        settleTimer = null;
      }
    },
  };
}

export function isPasteShortcut(event: KeyboardEventLike): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    String(event.key).toLowerCase() === "v"
  );
}

function isPasteReleaseEvent(event: KeyboardEventLike): boolean {
  const key = String(event.key).toLowerCase();
  return key === "v" || key === "meta" || key === "control";
}

export function createDeferredPasteController({
  readClipboardText,
  onPasteText,
  onPasteError,
}: {
  readClipboardText: () => Promise<string>;
  onPasteText: (text: string, modifiers: PasteModifiers) => void;
  onPasteError: (message: string) => void;
}) {
  let pendingPaste: {
    textPromise: Promise<string>;
    modifiers: PasteModifiers;
    waitForModifierRelease: boolean;
  } | null = null;
  let focusGeneration = 0;
  const pressedModifierKeys = new Set<string>();

  async function flushPendingPaste() {
    if (pendingPaste === null) {
      return;
    }

    const { textPromise, modifiers } = pendingPaste;
    const generation = focusGeneration;
    pendingPaste = null;

    try {
      const text = await textPromise;
      if (generation !== focusGeneration) {
        return;
      }
      if (!text) {
        onPasteError("Local clipboard is empty.");
        return;
      }

      onPasteText(text, modifiers);
    } catch {
      onPasteError("Browser blocked clipboard read.");
    }
  }

  return {
    cancel() {
      focusGeneration += 1;
      pendingPaste = null;
      pressedModifierKeys.clear();
    },

    handleKeyDown(event: KeyboardEventLike) {
      const key = String(event.key).toLowerCase();
      if (key === "meta" || key === "control") {
        pressedModifierKeys.add(event.code || key);
        return false;
      }

      if (!isPasteShortcut(event)) {
        return false;
      }

      event.preventDefault();
      event.stopPropagation();

      if (pendingPaste === null) {
        pendingPaste = {
          textPromise: readClipboardText(),
          modifiers: {
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
          },
          waitForModifierRelease: pressedModifierKeys.size > 0,
        };
      }

      return true;
    },

    handleKeyUp(event: KeyboardEventLike) {
      const key = String(event.key).toLowerCase();
      if (key === "meta" || key === "control") {
        pressedModifierKeys.delete(event.code || key);
      }

      if (pendingPaste === null || !isPasteReleaseEvent(event)) {
        return false;
      }

      if (
        (key !== "v" || pendingPaste.waitForModifierRelease) &&
        (event.metaKey || event.ctrlKey)
      ) {
        return true;
      }

      void flushPendingPaste();
      return true;
    },
  };
}

export function isApplePlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function createMetaToControlController(rfb: RemoteKeySender, enabled: boolean) {
  const pressedMetaKeys = new Set<string>();
  const implicitMetaChordKeys = new Set<string>();

  function pressRemoteControl() {
    if (pressedMetaKeys.size === 0 && implicitMetaChordKeys.size === 0) {
      rfb.sendKey(0xffe3, "ControlLeft", true);
    }
  }

  function releaseRemoteControlIfIdle() {
    if (pressedMetaKeys.size === 0 && implicitMetaChordKeys.size === 0) {
      rfb.sendKey(0xffe3, "ControlLeft", false);
    }
  }

  function intercept(event: KeyboardEventLike) {
    if (!enabled || String(event.key).toLowerCase() !== "meta") {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function release() {
    if (pressedMetaKeys.size === 0 && implicitMetaChordKeys.size === 0) {
      return;
    }
    pressedMetaKeys.clear();
    implicitMetaChordKeys.clear();
    rfb.sendKey(0xffe3, "ControlLeft", false);
  }

  return {
    handleKeyDown(event: KeyboardEventLike) {
      if (!enabled) {
        return false;
      }

      if (String(event.key).toLowerCase() !== "meta") {
        if (event.metaKey && pressedMetaKeys.size === 0) {
          const code = event.code || String(event.key);
          if (!implicitMetaChordKeys.has(code)) {
            pressRemoteControl();
            implicitMetaChordKeys.add(code);
          }
        }
        return false;
      }

      intercept(event);
      const code = event.code || "MetaLeft";
      if (pressedMetaKeys.has(code)) {
        return true;
      }
      pressRemoteControl();
      pressedMetaKeys.add(code);
      return true;
    },

    handleKeyUp(event: KeyboardEventLike) {
      if (!enabled) {
        return false;
      }

      if (String(event.key).toLowerCase() !== "meta") {
        const code = event.code || String(event.key);
        if (implicitMetaChordKeys.delete(code)) {
          releaseRemoteControlIfIdle();
        }
        return false;
      }

      intercept(event);
      pressedMetaKeys.delete(event.code || "MetaLeft");
      releaseRemoteControlIfIdle();
      return true;
    },

    release,
  };
}

export function isTouchDevice() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

interface Size {
  width: number;
  height: number;
}

interface ViewportTransform {
  scale: number;
  tx: number;
  ty: number;
}

interface GestureState extends ViewportTransform {
  center: { x: number; y: number };
  distance: number;
}

export function computeFitTransform({
  frameWidth,
  frameHeight,
  contentWidth,
  contentHeight,
}: {
  frameWidth: number;
  frameHeight: number;
  contentWidth: number;
  contentHeight: number;
}): ViewportTransform {
  if (!frameWidth || !frameHeight || !contentWidth || !contentHeight) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const scale = Math.min(frameWidth / contentWidth, frameHeight / contentHeight);
  return {
    scale,
    tx: (frameWidth - contentWidth * scale) / 2,
    ty: (frameHeight - contentHeight * scale) / 2,
  };
}

export function computeGestureTransform({
  start,
  current,
  scaleBounds,
}: {
  start: GestureState;
  current: Pick<GestureState, "center" | "distance">;
  scaleBounds: { min: number; max: number };
}): ViewportTransform {
  const rawScale = start.scale * (current.distance / start.distance);
  const scale = Math.min(Math.max(rawScale, scaleBounds.min), scaleBounds.max);
  const k = scale / start.scale;
  return {
    scale,
    tx: current.center.x - (start.center.x - start.tx) * k,
    ty: current.center.y - (start.center.y - start.ty) * k,
  };
}

function getRelativePoint(clientX: number, clientY: number, frameRect: DOMRect) {
  return { x: clientX - frameRect.left, y: clientY - frameRect.top };
}

const syntheticPointerEvents = new WeakSet<Event>();

function pointerSummary(pointers: Map<number, { x: number; y: number }>) {
  const points = [...pointers.values()];
  if (points.length < 2) {
    return null;
  }
  const [a, b] = points;
  return {
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
  };
}

export function createTouchViewport({
  frame,
  wrap,
  getContentSize,
  cancelPointer,
  scaleBounds = { min: 0.25, max: 4 },
}: {
  frame: HTMLElement;
  wrap: HTMLElement;
  getContentSize: () => Size;
  cancelPointer: (pointerId: number) => void;
  scaleBounds?: { min: number; max: number };
}) {
  const pointers = new Map<number, { x: number; y: number }>();
  let gestureStart: GestureState | null = null;
  let scale = 1;
  let tx = 0;
  let ty = 0;

  function applyTransform() {
    const content = getContentSize();
    wrap.style.left = `${tx}px`;
    wrap.style.top = `${ty}px`;
    wrap.style.width = `${content.width * scale}px`;
    wrap.style.height = `${content.height * scale}px`;
  }

  function fitToFrame() {
    const frameRect = frame.getBoundingClientRect();
    const content = getContentSize();
    const fit = computeFitTransform({
      frameWidth: frameRect.width,
      frameHeight: frameRect.height,
      contentWidth: content.width,
      contentHeight: content.height,
    });
    scale = fit.scale;
    tx = fit.tx;
    ty = fit.ty;
    applyTransform();
  }

  function clampScaleBounds() {
    const content = getContentSize();
    const frameRect = frame.getBoundingClientRect();
    const fit = computeFitTransform({
      frameWidth: frameRect.width,
      frameHeight: frameRect.height,
      contentWidth: content.width,
      contentHeight: content.height,
    });
    return {
      min: fit.scale * 0.9,
      max: fit.scale * 6,
    };
  }

  function trackPointer(event: PointerEvent) {
    if (event.pointerType !== "touch") {
      return false;
    }
    const frameRect = frame.getBoundingClientRect();
    pointers.set(event.pointerId, getRelativePoint(event.clientX, event.clientY, frameRect));
    return true;
  }

  function handlePointerDown(event: PointerEvent) {
    if (syntheticPointerEvents.has(event)) return;
    if (!trackPointer(event)) return;
    if (pointers.size >= 2 && !gestureStart) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const summary = pointerSummary(pointers);
      if (!summary) return;
      gestureStart = {
        center: summary.center,
        distance: summary.distance,
        scale,
        tx,
        ty,
      };
      for (const id of pointers.keys()) {
        if (id !== event.pointerId) {
          cancelPointer(id);
        }
      }
    } else if (gestureStart) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function handlePointerMove(event: PointerEvent) {
    if (syntheticPointerEvents.has(event)) return;
    if (!pointers.has(event.pointerId)) return;
    if (event.pointerType !== "touch") return;
    const frameRect = frame.getBoundingClientRect();
    pointers.set(event.pointerId, getRelativePoint(event.clientX, event.clientY, frameRect));
    if (!gestureStart) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const summary = pointerSummary(pointers);
    if (!summary) return;
    const next = computeGestureTransform({
      start: gestureStart,
      current: summary,
      scaleBounds: { ...scaleBounds, ...clampScaleBounds() },
    });
    scale = next.scale;
    tx = next.tx;
    ty = next.ty;
    applyTransform();
  }

  function handlePointerEnd(event: PointerEvent) {
    if (syntheticPointerEvents.has(event)) return;
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (gestureStart) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (pointers.size < 2) {
        gestureStart = null;
      }
    }
  }

  frame.addEventListener("pointerdown", handlePointerDown, { capture: true });
  frame.addEventListener("pointermove", handlePointerMove, { capture: true, passive: false });
  frame.addEventListener("pointerup", handlePointerEnd, { capture: true });
  frame.addEventListener("pointercancel", handlePointerEnd, { capture: true });

  const resizeObserver =
    typeof ResizeObserver === "function" ? new ResizeObserver(() => fitToFrame()) : null;
  resizeObserver?.observe(frame);

  return {
    fitToFrame,
    getTransform: () => ({ scale, tx, ty }),
    destroy() {
      frame.removeEventListener("pointerdown", handlePointerDown, { capture: true });
      frame.removeEventListener("pointermove", handlePointerMove, { capture: true });
      frame.removeEventListener("pointerup", handlePointerEnd, { capture: true });
      frame.removeEventListener("pointercancel", handlePointerEnd, { capture: true });
      resizeObserver?.disconnect();
    },
  };
}

const KEYSYM_BACKSPACE = 0xff08;
const KEYSYM_ENTER = 0xff0d;
const KEYSYM_TAB = 0xff09;

function setupKeyboardToolbar(
  rfb: RemoteKeySender,
  screen: HTMLElement,
  pasteText: (text: string) => void,
) {
  const toggle = document.getElementById("kb-toggle");
  const input = document.getElementById("keyboard-input");
  if (!toggle) return;
  if (!(input instanceof HTMLInputElement)) return;
  const keyboardInput = input;

  let lastValue = "";
  let composing = false;
  let inputTimer: TimerHandle | null = null;

  function cancelInputTimer() {
    if (inputTimer === null) return;
    clearTimeout(inputTimer);
    inputTimer = null;
  }

  function flushInput() {
    cancelInputTimer();
    const next = keyboardInput.value;
    const oldCharacters = [...lastValue];
    const newCharacters = [...next];
    let commonPrefixLength = 0;
    while (
      commonPrefixLength < oldCharacters.length &&
      commonPrefixLength < newCharacters.length &&
      oldCharacters[commonPrefixLength] === newCharacters[commonPrefixLength]
    ) {
      commonPrefixLength += 1;
    }

    for (let index = commonPrefixLength; index < oldCharacters.length; index += 1) {
      rfb.sendKey(KEYSYM_BACKSPACE, "Backspace");
    }

    const added = newCharacters.slice(commonPrefixLength).join("");
    if (added) pasteText(added);
    lastValue = next;

    if (newCharacters.length > 64) {
      keyboardInput.value = "";
      lastValue = "";
    }
  }

  function scheduleInput() {
    cancelInputTimer();
    inputTimer = setTimeout(flushInput, 50);
  }

  function showKeyboard() {
    keyboardInput.value = "";
    lastValue = "";
    composing = false;
    cancelInputTimer();
    keyboardInput.removeAttribute("readonly");
    keyboardInput.focus({ preventScroll: true });
  }

  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    if (document.activeElement === keyboardInput) {
      keyboardInput.blur();
      screen.focus();
    } else {
      showKeyboard();
    }
  });

  // Soft keyboards on iOS/Android often suppress keydown events. Send their
  // committed text through the UTF-8 clipboard path used by regular paste.
  keyboardInput.addEventListener("compositionstart", () => {
    composing = true;
    cancelInputTimer();
  });
  keyboardInput.addEventListener("compositionend", () => {
    composing = false;
    scheduleInput();
  });
  keyboardInput.addEventListener("input", () => {
    if (!composing) scheduleInput();
  });

  // Hardware keyboards still fire keydown on the input — forward those too.
  keyboardInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      flushInput();
      rfb.sendKey(KEYSYM_ENTER, "Enter");
    } else if (e.key === "Backspace" && keyboardInput.value === "") {
      e.preventDefault();
      rfb.sendKey(KEYSYM_BACKSPACE, "Backspace");
    } else if (e.key === "Tab") {
      e.preventDefault();
      flushInput();
      rfb.sendKey(KEYSYM_TAB, "Tab");
    }
  });
}

function dispatchSyntheticPointerCancel(target: Element | null, pointerId: number) {
  if (!target || typeof PointerEvent !== "function") return;
  try {
    const event = new PointerEvent("pointercancel", {
      pointerId,
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
    });
    syntheticPointerEvents.add(event);
    target.dispatchEvent(event);
  } catch {}
}

export function initDesktopVnc(RFB: DesktopRfbConstructor): void {
  const screen = document.getElementById("screen");
  const wrap = document.getElementById("screen-wrap");
  const frame = document.getElementById("viewport-frame");

  if (!(screen instanceof HTMLElement)) {
    throw new Error("Desktop VNC UI is missing required elements.");
  }
  if (!(wrap instanceof HTMLElement)) {
    throw new Error("Desktop VNC UI is missing required elements.");
  }
  if (!(frame instanceof HTMLElement)) {
    throw new Error("Desktop VNC UI is missing required elements.");
  }
  const screenElement = screen;

  const params = new URLSearchParams(window.location.search);
  const path = params.get("path") ?? "desktop-proxy/websockify";
  const resize = params.get("resize") ?? "remote";
  const touchOverride = params.get("touch");
  const touchMode = touchOverride === "1" ? true : touchOverride === "0" ? false : isTouchDevice();
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${protocol}://${window.location.host}/${path}`;

  const rfb = new RFB(screenElement, wsUrl);
  const remoteClipboardPaste = createRemoteClipboardPasteController({ rfb });
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  const metaToControl = createMetaToControlController(rfb, isApplePlatform(platform));

  function focusRemote() {
    screenElement.focus();
    rfb.focus();
  }

  function remoteHasFocus(target: EventTarget | null) {
    if (target instanceof Node && screenElement.contains(target)) {
      return true;
    }

    const activeElement = document.activeElement;
    return activeElement instanceof Node && screenElement.contains(activeElement);
  }

  function releasePasteModifiers(modifiers: PasteModifiers) {
    if (modifiers?.ctrlKey || modifiers?.metaKey) {
      for (const key of PASTE_MODIFIER_KEYS.control) {
        rfb.sendKey(key.keysym, key.code, false);
      }
    }

    if (modifiers?.metaKey) {
      for (const key of PASTE_MODIFIER_KEYS.meta) {
        rfb.sendKey(key.keysym, key.code, false);
      }
    }
  }

  function pasteTextToRemote(text: string, modifiers: PasteModifiers) {
    focusRemote();
    releasePasteModifiers(modifiers);
    remoteClipboardPaste.paste(text);
  }

  const deferredPaste = createDeferredPasteController({
    readClipboardText: () => navigator.clipboard.readText(),
    onPasteText: pasteTextToRemote,
    onPasteError: () => {},
  });

  rfb.viewOnly = false;

  let touchViewport: ReturnType<typeof createTouchViewport> | null = null;

  if (touchMode) {
    frame.classList.add("touch-mode");
    document.body.classList.add("touch-mode");
    rfb.scaleViewport = true;
    rfb.clipViewport = false;
    rfb.dragViewport = false;
    rfb.resizeSession = false;
  } else {
    rfb.scaleViewport = resize === "scale";
    rfb.resizeSession = resize === "remote";
  }

  function getCanvas() {
    return screenElement.querySelector("canvas");
  }

  function getCanvasSize() {
    const canvas = getCanvas();
    if (!canvas || !canvas.width || !canvas.height) {
      return { width: 1, height: 1 };
    }
    return { width: canvas.width, height: canvas.height };
  }

  rfb.addEventListener("connect", () => {
    focusRemote();
    if (touchMode) {
      touchViewport = createTouchViewport({
        frame,
        wrap,
        getContentSize: getCanvasSize,
        cancelPointer: (id) => dispatchSyntheticPointerCancel(getCanvas(), id),
      });
      touchViewport.fitToFrame();
    }
  });

  if (touchMode) {
    const refit = () => touchViewport?.fitToFrame();
    rfb.addEventListener("desktopname", refit);
    window.addEventListener("resize", refit);
    setupKeyboardToolbar(rfb, screenElement, (text) => remoteClipboardPaste.paste(text));
  }

  rfb.addEventListener("clipboard", async (event) => {
    const text = (event as CustomEvent<{ text?: string }>).detail.text ?? "";
    if (!text) {
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  });

  document.addEventListener(
    "keydown",
    (event) => {
      if (!remoteHasFocus(event.target)) {
        return;
      }

      if (deferredPaste.handleKeyDown(event)) {
        return;
      }
      metaToControl.handleKeyDown(event);
    },
    { capture: true },
  );
  document.addEventListener(
    "keyup",
    (event) => {
      deferredPaste.handleKeyUp(event);
      metaToControl.handleKeyUp(event);
    },
    { capture: true },
  );

  window.addEventListener("pointerdown", () => {
    focusRemote();
  });
  window.addEventListener("blur", () => {
    deferredPaste.cancel();
    metaToControl.release();
    rfb.blur();
  });
  window.addEventListener("pagehide", () => {
    deferredPaste.cancel();
    metaToControl.release();
    remoteClipboardPaste.destroy();
    touchViewport?.destroy();
    rfb.disconnect();
  });

  focusRemote();
}
