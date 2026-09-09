// GA4 page-visit analytics. Observability: docs/architecture/observability.md.
// Enhanced Measurement owns page views:
// the loader calls gtag("config", id) with defaults, so the initial page_view
// comes from config and every later one from the GA4 stream's history-events
// toggle, which must stay on. There is deliberately no route
// hook, no pushState wrapper, no dedupe, and no URL sanitization here; raw
// URLs reach GA without sanitization by design.
//
// The measurement ID arrives via the boot-written /runtime-config.js asset
// (window.__ROME_RUNTIME_CONFIG__ — packages/core/src/lib/runtime-config.ts):
// Caddy serves the production shell straight from disk, so runtime config must
// be a real file next to it, and one runtime env var then governs the SPA and
// the gateway page alike.

// A GA4 session expires after 30 idle minutes.
const REENGAGE_AFTER_MS = 30 * 60 * 1000;

declare global {
  interface Window {
    __ROME_RUNTIME_CONFIG__?: { gaMeasurementId?: string | null };
    /** Tears down the previous idle listener so re-init can never stack handlers. */
    __ROME_ANALYTICS_IDLE_ABORT__?: AbortController;
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let started = false;
let hiddenSince: number | null = null;

// Pure gate, exported for tests (window.top is unforgeable in jsdom, so the
// iframe case can only be exercised through an injected window-like).
export function shouldLoadAnalytics(
  win: Pick<Window, "self" | "top">,
  measurementId: string | null | undefined,
): boolean {
  // Empty or absent IDs disable analytics entirely.
  if (!measurementId?.trim()) return false;
  // Workspace widgets load this same SPA same-origin in an iframe at
  // /full/apps/<appId>; loading GA there would let Enhanced Measurement count
  // every widget render as an app visit. Widget renders are counted by
  // rome_widget_render from the parent window instead. Desktop is tracked like
  // any browser.
  return win.self === win.top;
}

export function initAnalytics(): void {
  const measurementId = window.__ROME_RUNTIME_CONFIG__?.gaMeasurementId?.trim();
  if (started || !measurementId || !shouldLoadAnalytics(window, measurementId)) return;
  started = true;

  window.dataLayer = window.dataLayer ?? [];
  window.gtag = function gtag() {
    // gtag.js only processes genuine Arguments objects pushed to dataLayer —
    // a rest-parameter array is silently ignored.
    window.dataLayer?.push(arguments);
  };
  window.gtag("js", new Date());
  // Defaults on purpose: send_page_view stays true (the initial view) and
  // Enhanced Measurement fires every subsequent history-change view. Adding a
  // manual page_view on navigation would double-count.
  window.gtag("config", measurementId);

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.appendChild(script);

  // A dashboard tab lives for days but a GA4 session expires after 30 idle
  // minutes; a user returning to a stale tab would start a session with no
  // page_view (and no landing page) unless they navigate. Re-fire one view
  // when the tab becomes visible after ≥30 hidden minutes — the sole manual
  // page_view. The idle gate prevents it from doubling an Enhanced Measurement
  // navigation view.
  // Abort-keyed registration: a re-init (or a test module reset, which clears
  // this module's state but not the document's listeners) replaces the handler
  // instead of stacking a duplicate.
  window.__ROME_ANALYTICS_IDLE_ABORT__?.abort();
  const idleAbort = new AbortController();
  window.__ROME_ANALYTICS_IDLE_ABORT__ = idleAbort;
  hiddenSince = document.visibilityState === "hidden" ? Date.now() : null;
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      hiddenSince = hiddenSince ?? Date.now();
      return;
    }
    const idleFor = hiddenSince === null ? 0 : Date.now() - hiddenSince;
    hiddenSince = null;
    if (idleFor >= REENGAGE_AFTER_MS) {
      // No params: gtag reads page_location/title from the live document —
      // the same raw-URL exposure as every other view.
      window.gtag?.("event", "page_view");
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange, { signal: idleAbort.signal });
}

export function trackEvent(name: string, params?: Record<string, unknown>): void {
  if (!started) return;
  window.gtag?.("event", name, params);
}

export type AppOpenSurface = "embedded" | "full" | "inline";

// Called from BOTH mount paths — RomeAppHost (embedded + full pages) and
// AppComponentBlock (inline chat components bypass RomeAppHost), so every app
// open is one event regardless of surface. Custom names are rome_-prefixed to
// avoid GA/Firebase auto-collected semantics.
export function trackAppOpen(
  appId: string,
  surface: AppOpenSurface,
  visitorEmail?: string | null,
): void {
  trackEvent("rome_app_open", {
    app_id: appId,
    surface,
    visitor_email: visitorEmail?.trim() || "guest",
  });
}

// Widget renders are counted from the PARENT window when the host mounts the
// iframe. The iframe never loads GA, so widget renders are an event,
// not a page view, and in-widget navigation stays untracked by design.
export function trackWidgetRender(appId: string): void {
  trackEvent("rome_widget_render", { app_id: appId });
}
