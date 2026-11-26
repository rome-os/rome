// Reads the text the user selected in whatever app is in front, for the share
// shortcut. macOS only, and only with Rome allowed in Accessibility.
//
// Accessibility answers first: it reads the selection without touching the
// clipboard. Apps that do not report their selection that way (Chrome and
// Electron apps, unless asked to build their accessibility tree) get a ⌘C
// instead, and the clipboard is put back afterwards.

import { clipboard, systemPreferences } from "electron";
import { createLogger } from "../logger";

const log = createLogger("share-shortcut");

/** The macOS calls this file makes. Injected in tests. */
export interface MacText {
  /** The focused element's selected text through Accessibility, or null. */
  selectedText(): string | null;
  /** NSPasteboard's change count, which goes up on every write to the clipboard. */
  pasteboardChangeCount(): number;
  /** Posts ⌘C to the frontmost app. */
  pressCopy(): void;
}

// How long an app gets to answer an Accessibility request. The call blocks the
// main process, so a hung app must not hold it longer than a keystroke.
const AX_TIMEOUT_SECONDS = 0.25;
const COPY_WAIT_MS = 300;
const COPY_POLL_MS = 20;

function loadMacText(): MacText {
  // Loaded on first use rather than imported, as in prevent-activation.ts.
  const koffi = require("koffi") as typeof import("koffi");
  const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const ax = koffi.load(
    "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
  );
  const cg = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
  const objc = koffi.load("/usr/lib/libobjc.A.dylib");

  const UTF8 = 0x08000100; // kCFStringEncodingUTF8
  const cfString = cf.func("CFStringCreateWithCString", "void *", ["void *", "str", "uint32"]);
  const cfRelease = cf.func("CFRelease", "void", ["void *"]);
  const cfGetTypeId = cf.func("CFGetTypeID", "ulong", ["void *"]);
  const cfStringTypeId = cf.func("CFStringGetTypeID", "ulong", [])() as number;

  const axSystemWide = ax.func("AXUIElementCreateSystemWide", "void *", []);
  const axSetTimeout = ax.func("AXUIElementSetMessagingTimeout", "int32", ["void *", "float"]);
  const axCopyAttribute = ax.func("AXUIElementCopyAttributeValue", "int32", [
    "void *",
    "void *",
    koffi.out(koffi.pointer("void *")),
  ]);

  const eventSource = cg.func("CGEventSourceCreate", "void *", ["int32"]);
  const keyEvent = cg.func("CGEventCreateKeyboardEvent", "void *", ["void *", "uint16", "bool"]);
  const setFlags = cg.func("CGEventSetFlags", "void", ["void *", "uint64"]);
  const postEvent = cg.func("CGEventPost", "uint32", ["uint32", "void *"]);

  const getClass = objc.func("objc_getClass", "void *", ["str"]);
  const sel = objc.func("sel_registerName", "void *", ["str"]);
  // objc_msgSend takes the callee's exact signature, so it is bound once per
  // shape of message sent.
  const sendId = objc.func("objc_msgSend", "void *", ["void *", "void *"]);
  const sendLong = objc.func("objc_msgSend", "long", ["void *", "void *"]);
  const sendString = objc.func("objc_msgSend", "str", ["void *", "void *"]);

  // Created once and kept: these live as long as the process.
  const system = axSystemWide();
  axSetTimeout(system, AX_TIMEOUT_SECONDS);
  const focusedAttr = cfString(null, "AXFocusedUIElement", UTF8);
  const selectedTextAttr = cfString(null, "AXSelectedText", UTF8);
  const utf8Selector = sel("UTF8String");

  const copyAttribute = (element: unknown, attribute: unknown): unknown => {
    const out: unknown[] = [null];
    const error = axCopyAttribute(element, attribute, out) as number;
    return error === 0 ? out[0] : null;
  };

  return {
    selectedText: () => {
      const focused = copyAttribute(system, focusedAttr);
      if (!focused) return null;
      try {
        const value = copyAttribute(focused, selectedTextAttr);
        if (!value) return null;
        try {
          if (cfGetTypeId(value) !== cfStringTypeId) return null;
          // A CFString is an NSString, so it can hand over its UTF-8 bytes.
          return (sendString(value, utf8Selector) as string | null) ?? null;
        } finally {
          cfRelease(value);
        }
      } finally {
        cfRelease(focused);
      }
    },
    pasteboardChangeCount: () =>
      sendLong(
        sendId(getClass("NSPasteboard"), sel("generalPasteboard")),
        sel("changeCount"),
      ) as number,
    pressCopy: () => {
      const KEY_C = 8; // kVK_ANSI_C
      const COMMAND = 0x100000; // kCGEventFlagMaskCommand
      // A private source, so the Option key still held from the shortcut does
      // not ride along and turn ⌘C into another command.
      const source = eventSource(-1);
      for (const down of [true, false]) {
        const event = keyEvent(source, KEY_C, down);
        setFlags(event, COMMAND);
        postEvent(0, event); // kCGHIDEventTap
        cfRelease(event);
      }
      if (source) cfRelease(source);
    },
  };
}

let mac: MacText | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Copies the selection with ⌘C, then puts back what the clipboard held. */
async function copySelection(text: MacText): Promise<string | null> {
  const before = text.pasteboardChangeCount();
  const saved = await clipboard.read();
  text.pressCopy();
  for (let waited = 0; waited < COPY_WAIT_MS; waited += COPY_POLL_MS) {
    await sleep(COPY_POLL_MS);
    if (text.pasteboardChangeCount() === before) continue;
    const copied = await clipboard.readText();
    if (saved.length > 0) await clipboard.write(saved);
    else clipboard.clear();
    return copied;
  }
  // Nothing was selected, or the app has no Copy: the clipboard never changed.
  return null;
}

/**
 * The selection in the frontmost app, or null when there is none or Rome may
 * not read it. The first call without Accessibility asks macOS to show its
 * prompt.
 */
export async function readSelectedText(macText?: MacText): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    systemPreferences.isTrustedAccessibilityClient(true);
    log.info("Accessibility is off for Rome, so the share shortcut opens without the selection");
    return null;
  }
  try {
    const text = macText ?? (mac ??= loadMacText());
    const selected = text.selectedText()?.trim();
    if (selected) return selected;
    return (await copySelection(text))?.trim() || null;
  } catch (err) {
    log.warn(`Could not read the selection (${String(err)})`);
    return null;
  }
}
