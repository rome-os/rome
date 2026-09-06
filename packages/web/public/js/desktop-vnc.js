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

export function sendRemotePasteShortcut(rfb) {
  rfb.sendKey(0xffe3, "ControlLeft", true);
  rfb.sendKey(0x76, "KeyV", true);
  rfb.sendKey(0x76, "KeyV", false);
  rfb.sendKey(0xffe3, "ControlLeft", false);
}

export function createRemoteClipboardPasteController({
  rfb,
  observeClipboardProvide,
  fallbackDelay = 1_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const queue = [];
  let activeText = null;
  let fallbackTimer = null;
  let destroyed = false;

  function startNextPaste() {
    if (destroyed || activeText !== null || queue.length === 0) {
      return;
    }

    activeText = queue.shift();
    fallbackTimer = setTimer(completePaste, fallbackDelay);
    rfb.clipboardPasteFrom(activeText);
  }

  function completePaste() {
    if (destroyed || activeText === null) {
      return;
    }

    if (fallbackTimer !== null) {
      clearTimer(fallbackTimer);
      fallbackTimer = null;
    }
    activeText = null;
    sendRemotePasteShortcut(rfb);
    startNextPaste();
  }

  const stopObserving = observeClipboardProvide?.(completePaste) ?? (() => {});

  return {
    paste(text) {
      if (!text || destroyed) {
        return;
      }
      queue.push(text);
      startNextPaste();
    },

    destroy() {
      destroyed = true;
      queue.length = 0;
      activeText = null;
      if (fallbackTimer !== null) {
        clearTimer(fallbackTimer);
        fallbackTimer = null;
      }
      stopObserving();
    },
  };
}

export function isPasteShortcut(event) {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    String(event.key).toLowerCase() === "v"
  );
}

function isPasteReleaseEvent(event) {
  const key = String(event.key).toLowerCase();
  return key === "v" || key === "meta" || key === "control";
}

export function createDeferredPasteController({ readClipboardText, onPasteText, onPasteError }) {
  let pendingPaste = null;
  let focusGeneration = 0;

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
    },

    handleKeyDown(event) {
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
        };
      }

      return true;
    },

    handleKeyUp(event) {
      if (pendingPaste === null || !isPasteReleaseEvent(event)) {
        return false;
      }

      if (event.metaKey || event.ctrlKey) {
        return true;
      }

      void flushPendingPaste();
      return true;
    },
  };
}

export function isApplePlatform(platform) {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function createMetaToControlController(rfb, enabled) {
  const pressedMetaKeys = new Set();

  function intercept(event) {
    if (!enabled || String(event.key).toLowerCase() !== "meta") {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function release() {
    if (pressedMetaKeys.size === 0) {
      return;
    }
    pressedMetaKeys.clear();
    rfb.sendKey(0xffe3, "ControlLeft", false);
  }

  return {
    handleKeyDown(event) {
      if (!intercept(event)) {
        return false;
      }
      const code = event.code || "MetaLeft";
      if (pressedMetaKeys.has(code)) {
        return true;
      }
      if (pressedMetaKeys.size === 0) {
        rfb.sendKey(0xffe3, "ControlLeft", true);
      }
      pressedMetaKeys.add(code);
      return true;
    },

    handleKeyUp(event) {
      if (!intercept(event)) {
        return false;
      }
      pressedMetaKeys.delete(event.code || "MetaLeft");
      if (pressedMetaKeys.size === 0) {
        rfb.sendKey(0xffe3, "ControlLeft", false);
      }
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

export function computeFitTransform({ frameWidth, frameHeight, contentWidth, contentHeight }) {
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

export function computeGestureTransform({ start, current, scaleBounds }) {
  const rawScale = start.scale * (current.distance / start.distance);
  const scale = Math.min(Math.max(rawScale, scaleBounds.min), scaleBounds.max);
  const k = scale / start.scale;
  return {
    scale,
    tx: current.center.x - (start.center.x - start.tx) * k,
    ty: current.center.y - (start.center.y - start.ty) * k,
  };
}

function getRelativePoint(clientX, clientY, frameRect) {
  return { x: clientX - frameRect.left, y: clientY - frameRect.top };
}

const SYNTHETIC_FLAG = "__romeSyntheticPointer";

function pointerSummary(pointers) {
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
}) {
  const pointers = new Map();
  let gestureStart = null;
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

  function trackPointer(event) {
    if (event.pointerType !== "touch") {
      return false;
    }
    const frameRect = frame.getBoundingClientRect();
    pointers.set(event.pointerId, getRelativePoint(event.clientX, event.clientY, frameRect));
    return true;
  }

  function handlePointerDown(event) {
    if (event[SYNTHETIC_FLAG]) return;
    if (!trackPointer(event)) return;
    if (pointers.size >= 2 && !gestureStart) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const summary = pointerSummary(pointers);
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

  function handlePointerMove(event) {
    if (event[SYNTHETIC_FLAG]) return;
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

  function handlePointerEnd(event) {
    if (event[SYNTHETIC_FLAG]) return;
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

function setupKeyboardToolbar(rfb, screen, pasteText) {
  const toggle = document.getElementById("kb-toggle");
  const input = document.getElementById("keyboard-input");
  if (!toggle || !input) return;

  let lastValue = "";

  function showKeyboard() {
    input.value = "";
    lastValue = "";
    input.removeAttribute("readonly");
    input.focus({ preventScroll: true });
  }

  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    if (document.activeElement === input) {
      input.blur();
      screen.focus();
    } else {
      showKeyboard();
    }
  });

  // Soft keyboards on iOS/Android often suppress keydown events. Send their
  // committed text through the UTF-8 clipboard path used by regular paste.
  input.addEventListener("input", () => {
    const next = input.value;
    const oldLen = [...lastValue].length;
    const newLen = [...next].length;
    if (newLen < oldLen) {
      for (let i = 0; i < oldLen - newLen; i++) {
        rfb.sendKey(KEYSYM_BACKSPACE, "Backspace");
      }
    } else if (newLen > oldLen) {
      const added = [...next].slice(oldLen).join("");
      pasteText(added);
    }
    lastValue = next;
    if (next.length > 64) {
      input.value = "";
      lastValue = "";
    }
  });

  // Hardware keyboards still fire keydown on the input — forward those too.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      rfb.sendKey(KEYSYM_ENTER, "Enter");
    } else if (e.key === "Backspace" && input.value === "") {
      e.preventDefault();
      rfb.sendKey(KEYSYM_BACKSPACE, "Backspace");
    } else if (e.key === "Tab") {
      e.preventDefault();
      rfb.sendKey(KEYSYM_TAB, "Tab");
    }
  });
}

function dispatchSyntheticPointerCancel(target, pointerId) {
  if (!target || typeof PointerEvent !== "function") return;
  try {
    const event = new PointerEvent("pointercancel", {
      pointerId,
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
    });
    Object.defineProperty(event, SYNTHETIC_FLAG, { value: true });
    target.dispatchEvent(event);
  } catch {}
}

export async function initDesktopVnc() {
  const { default: RFB } = await import("/desktop-proxy/core/rfb.js");
  const screen = document.getElementById("screen");
  const wrap = document.getElementById("screen-wrap");
  const frame = document.getElementById("viewport-frame");

  if (
    !(screen instanceof HTMLElement) ||
    !(wrap instanceof HTMLElement) ||
    !(frame instanceof HTMLElement)
  ) {
    throw new Error("Desktop VNC UI is missing required elements.");
  }

  const params = new URLSearchParams(window.location.search);
  const path = params.get("path") ?? "desktop-proxy/websockify";
  const resize = params.get("resize") ?? "remote";
  const touchOverride = params.get("touch");
  const touchMode = touchOverride === "1" ? true : touchOverride === "0" ? false : isTouchDevice();
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${protocol}://${window.location.host}/${path}`;

  const rfb = new RFB(screen, wsUrl);

  function observeClipboardProvide(callback) {
    const messages = RFB.messages;
    const socket = rfb._sock;
    const originalProvide = messages?.extendedClipboardProvide;
    if (!messages || !socket || typeof originalProvide !== "function") {
      return () => {};
    }

    function observedProvide(targetSocket, ...args) {
      const result = originalProvide.call(this, targetSocket, ...args);
      if (targetSocket === socket) {
        callback();
      }
      return result;
    }

    messages.extendedClipboardProvide = observedProvide;
    return () => {
      if (messages.extendedClipboardProvide === observedProvide) {
        messages.extendedClipboardProvide = originalProvide;
      }
    };
  }

  const remoteClipboardPaste = createRemoteClipboardPasteController({
    rfb,
    observeClipboardProvide,
  });
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
  const metaToControl = createMetaToControlController(rfb, isApplePlatform(platform));

  function focusRemote() {
    screen.focus();
    rfb.focus();
  }

  function remoteHasFocus(target) {
    if (target instanceof Node && screen.contains(target)) {
      return true;
    }

    const activeElement = document.activeElement;
    return activeElement instanceof Node && screen.contains(activeElement);
  }

  function releasePasteModifiers(modifiers) {
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

  function pasteTextToRemote(text, modifiers) {
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

  let touchViewport = null;

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
    return screen.querySelector("canvas");
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
    setupKeyboardToolbar(rfb, screen, (text) => remoteClipboardPaste.paste(text));
  }

  rfb.addEventListener("clipboard", async (event) => {
    const text = event.detail.text ?? "";
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
  });
  window.addEventListener("pagehide", () => {
    deferredPaste.cancel();
    metaToControl.release();
    remoteClipboardPaste.destroy();
  });

  focusRemote();
}
