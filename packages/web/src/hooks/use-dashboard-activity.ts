// Tells the server whether the guardian is at this dashboard, so the
// Concierge holds back its pushes to their phone meanwhile:
// docs/architecture/notification-delivery.md. Input on a visible, focused tab
// reports `active`; hiding the tab, leaving the window or closing the page
// reports `away` at once. A page inside the phone app's web view reports
// nothing: closing that view may not fire `pagehide`, which would hold back
// the next push while the phone is locked.
import { useContext, useEffect } from "react";
import type { LiveEventsClient } from "@/lib/live-events";
import { LiveEventsClientContext } from "./use-live-events";

const INPUT_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"] as const;

/** The iOS app's web view names itself in the user agent as `RomeiOS/<version>`. */
const PHONE_APP_WEB_VIEW = /\bRomeiOS\//;

/**
 * Starts reporting this tab's activity through `client`. Returns the stop.
 * Inside the phone app's web view it reports nothing.
 */
export function watchDashboardActivity(
  client: Pick<LiveEventsClient, "reportActivity">,
  target: { window: Window; document: Document } = { window, document },
): () => void {
  const { window: win, document: doc } = target;
  if (PHONE_APP_WEB_VIEW.test(win.navigator.userAgent)) return () => {};
  const onInput = () => {
    if (doc.visibilityState === "visible" && doc.hasFocus()) client.reportActivity("active");
  };
  const onAway = () => client.reportActivity("away");
  const onVisibility = () => {
    if (doc.visibilityState !== "visible") onAway();
  };
  const options = { capture: true, passive: true };
  for (const type of INPUT_EVENTS) win.addEventListener(type, onInput, options);
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("blur", onAway);
  win.addEventListener("pagehide", onAway);
  return () => {
    for (const type of INPUT_EVENTS) win.removeEventListener(type, onInput, options);
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("blur", onAway);
    win.removeEventListener("pagehide", onAway);
  };
}

/** Reports this tab's activity while `enabled`: only a guardian's dashboard counts. */
export function useDashboardActivity(enabled: boolean): void {
  const client = useContext(LiveEventsClientContext);
  useEffect(() => {
    if (!enabled) return;
    return watchDashboardActivity(client);
  }, [client, enabled]);
}
