// Keeps a click on a window from activating Rome, through AppKit's private
// `-[NSWindow _setPreventsActivation:]`.
//
// `type: "panel"` is meant to do this on its own, but Electron's panel only
// reports the non-activating style from its `styleMask` getter and never sets
// it, so the window server activates the app on the press. macOS 27 does this
// to every panel (electron/electron#53889), and macOS 26.6 already does it to
// trackpad clicks and drags.

import type { BrowserWindow } from "electron";

const PREVENTS_ACTIVATION = "_setPreventsActivation:";

/** The Objective-C messages preventActivation sends. */
export interface ObjcRuntime {
  /** The NSWindow of the NSView in `view`, a handle from getNativeWindowHandle(). */
  windowOfView(view: Buffer): unknown;
  respondsToSelector(target: unknown, selector: string): boolean;
  sendBool(target: unknown, selector: string, value: boolean): void;
}

function loadObjcRuntime(): ObjcRuntime {
  // Loaded here rather than imported, so the native module is opened only on
  // the Mac that asks for it and never at startup elsewhere.
  const koffi = require("koffi") as typeof import("koffi");
  const objc = koffi.load("/usr/lib/libobjc.A.dylib");
  const sel = objc.func("sel_registerName", "void *", ["str"]);
  // objc_msgSend takes the callee's exact signature, so it is bound once per
  // shape of message sent.
  const sendId = objc.func("objc_msgSend", "void *", ["void *", "void *"]);
  const sendSelReturnBool = objc.func("objc_msgSend", "bool", ["void *", "void *", "void *"]);
  const sendBoolReturnVoid = objc.func("objc_msgSend", "void", ["void *", "void *", "bool"]);
  return {
    windowOfView: (view) => sendId(koffi.decode(view, "void *"), sel("window")),
    respondsToSelector: (target, selector) =>
      sendSelReturnBool(target, sel("respondsToSelector:"), sel(selector)),
    sendBool: (target, selector, value) => sendBoolReturnVoid(target, sel(selector), value),
  };
}

/**
 * Makes clicks on `win` leave the frontmost app frontmost. macOS only; call
 * once, before the window is shown.
 *
 * Returns false and changes nothing when AppKit no longer has the private
 * method, so a macOS release that drops it brings back the activation rather
 * than a crash. Throws when the Objective-C runtime cannot be loaded.
 */
export function preventActivation(
  win: Pick<BrowserWindow, "getNativeWindowHandle">,
  loadRuntime: () => ObjcRuntime = loadObjcRuntime,
): boolean {
  const objc = loadRuntime();
  const nsWindow = objc.windowOfView(win.getNativeWindowHandle());
  if (!nsWindow || !objc.respondsToSelector(nsWindow, PREVENTS_ACTIVATION)) return false;
  objc.sendBool(nsWindow, PREVENTS_ACTIVATION, true);
  return true;
}
