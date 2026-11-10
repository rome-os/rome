// Tells the server whether the person signed in, the guardian or a visitor, is
// at this dashboard, so the Concierge holds back its pushes to their phone
// meanwhile:
// docs/architecture/notification-delivery.md. Input on a visible, focused tab
// reports `active`; hiding the tab, leaving the window or closing the page
// reports `away` at once. Input inside a same-origin app iframe counts too. A
// page inside the phone app's web view reports nothing: closing that view may
// not fire `pagehide`, which would hold back the next push while the phone is
// locked.
import { useContext, useEffect } from "react";
import type { LiveEventsClient } from "@/lib/live-events";
import { LiveEventsClientContext } from "./use-live-events";

const INPUT_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"] as const;

/** The iOS app's web view names itself in the user agent as `RomeiOS/<version>`. */
const PHONE_APP_WEB_VIEW = /\bRomeiOS\//;
const IOS_DEVICE = /\b(iPhone|iPad|iPod)\b/;
const SAFARI = /\bSafari\//;

/**
 * Whether the page runs in an iOS app's web view rather than a browser. App
 * builds from before the `RomeiOS/` marker name nothing, but a WKWebView's user
 * agent lacks the `Safari/` token that Safari and every iOS browser carry.
 */
export function inPhoneAppWebView(userAgent: string): boolean {
  return (
    PHONE_APP_WEB_VIEW.test(userAgent) || (IOS_DEVICE.test(userAgent) && !SAFARI.test(userAgent))
  );
}

/**
 * Starts reporting this tab's activity through `client`. Returns the stop.
 * Inside the phone app's web view it reports nothing.
 */
export function watchDashboardActivity(
  client: Pick<LiveEventsClient, "reportActivity" | "hold">,
  target: { window: Window; document: Document } = { window, document },
): () => void {
  const { window: win, document: doc } = target;
  if (inPhoneAppWebView(win.navigator.userAgent)) return () => {};
  const onInput = () => {
    if (doc.visibilityState === "visible" && doc.hasFocus()) client.reportActivity("active");
  };
  const onAway = () => client.reportActivity("away");
  const onVisibility = () => {
    if (doc.visibilityState !== "visible") onAway();
  };
  // Focus moving into an embedded app's iframe blurs the window while the
  // document keeps focus, so the check waits until focus has settled.
  let blurCheck: ReturnType<typeof setTimeout> | undefined;
  const onBlur = () => {
    clearTimeout(blurCheck);
    blurCheck = setTimeout(() => {
      if (!doc.hasFocus()) onAway();
    }, 0);
  };
  // The signals need the socket open on a page that subscribes to no topic.
  const release = client.hold();
  const options = { capture: true, passive: true };
  const listenTo = (target: Window) => {
    for (const type of INPUT_EVENTS) target.addEventListener(type, onInput, options);
    return () => {
      for (const type of INPUT_EVENTS) target.removeEventListener(type, onInput, options);
    };
  };
  // Input in an app's iframe never reaches this window, so each same-origin
  // frame's own window is listened to, again after each load, since a
  // navigation gives the frame a new window. A cross-origin frame is skipped.
  const frames = new Map<HTMLIFrameElement, () => void>();
  const listenToFrame = (frame: HTMLIFrameElement) => {
    frames.get(frame)?.();
    let stop = () => {};
    try {
      const frameWindow = frame.contentWindow;
      // Reading a cross-origin frame's document throws.
      if (frameWindow?.document) stop = listenTo(frameWindow);
    } catch {
      // Cross-origin: its input stays its own.
    }
    frames.set(frame, stop);
  };
  const onFrameLoad = (event: Event) => listenToFrame(event.target as HTMLIFrameElement);
  const watchFrames = (root: ParentNode) => {
    const found = root instanceof HTMLIFrameElement ? [root] : [];
    if ("querySelectorAll" in root) found.push(...root.querySelectorAll("iframe"));
    for (const frame of found) {
      if (frames.has(frame)) continue;
      frame.addEventListener("load", onFrameLoad);
      listenToFrame(frame);
    }
  };
  const frameObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) watchFrames(node);
      }
    }
  });
  frameObserver.observe(doc.documentElement, { childList: true, subtree: true });
  watchFrames(doc);
  const stopWindow = listenTo(win);
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("blur", onBlur);
  win.addEventListener("pagehide", onAway);
  return () => {
    stopWindow();
    frameObserver.disconnect();
    for (const [frame, stop] of frames) {
      frame.removeEventListener("load", onFrameLoad);
      stop();
    }
    frames.clear();
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("blur", onBlur);
    win.removeEventListener("pagehide", onAway);
    clearTimeout(blurCheck);
    release();
  };
}

/** Reports this tab's activity while `enabled`: while someone is signed in. */
export function useDashboardActivity(enabled: boolean): void {
  const client = useContext(LiveEventsClientContext);
  useEffect(() => {
    if (!enabled) return;
    return watchDashboardActivity(client);
  }, [client, enabled]);
}
