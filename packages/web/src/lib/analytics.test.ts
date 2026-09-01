// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

// initAnalytics keeps module-level state (started flag, idle timestamp), so
// every test gets a fresh module instance.
async function loadAnalytics() {
  rs.resetModules();
  return await import("@/lib/analytics");
}

function dataLayerCalls(): unknown[][] {
  return (window.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
}

function eventsNamed(name: string): unknown[][] {
  return dataLayerCalls().filter((call) => call[0] === "event" && call[1] === name);
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  rs.useFakeTimers();
  window.dataLayer = undefined;
  window.gtag = undefined;
  window.__ROME_RUNTIME_CONFIG__ = undefined;
  window.__ROME_ANALYTICS_IDLE_ABORT__?.abort();
  window.__ROME_ANALYTICS_IDLE_ABORT__ = undefined;
  for (const el of document.querySelectorAll('script[src*="googletagmanager"]')) el.remove();
});

afterEach(() => {
  rs.useRealTimers();
});

describe("shouldLoadAnalytics", () => {
  it("requires a non-blank measurement id", async () => {
    const { shouldLoadAnalytics } = await loadAnalytics();
    const top = {} as Window;
    const win = { self: top, top } as Pick<Window, "self" | "top">;
    expect(shouldLoadAnalytics(win, undefined)).toBe(false);
    expect(shouldLoadAnalytics(win, null)).toBe(false);
    expect(shouldLoadAnalytics(win, "   ")).toBe(false);
    expect(shouldLoadAnalytics(win, "G-TEST1")).toBe(true);
  });

  it("refuses to load in an iframe (widget double-count guard)", async () => {
    const { shouldLoadAnalytics } = await loadAnalytics();
    const parent = {} as Window;
    const frame = {} as Window;
    expect(shouldLoadAnalytics({ self: frame, top: parent } as never, "G-TEST1")).toBe(false);
  });
});

describe("initAnalytics without a measurement id", () => {
  it("loads nothing and leaves tracking as a no-op", async () => {
    const { initAnalytics, trackEvent, trackAppOpen } = await loadAnalytics();
    initAnalytics(); // no __ROME_RUNTIME_CONFIG__ at all
    window.__ROME_RUNTIME_CONFIG__ = {};
    initAnalytics(); // stub config without an id
    trackEvent("rome_app_open", { app_id: "x" });
    trackAppOpen("x", "full");
    expect(window.gtag).toBeUndefined();
    expect(window.dataLayer).toBeUndefined();
    expect(document.querySelector('script[src*="googletagmanager"]')).toBeNull();
  });
});

describe("initAnalytics with a measurement id", () => {
  it("configures gtag with defaults and loads the tag with an encoded id", async () => {
    window.__ROME_RUNTIME_CONFIG__ = { gaMeasurementId: "G-TEST1" };
    const { initAnalytics } = await loadAnalytics();
    initAnalytics();

    // Enhanced Measurement owns page views: plain config call,
    // no send_page_view:false, no manual page_view on init.
    const configCall = dataLayerCalls().find((call) => call[0] === "config");
    expect(configCall).toEqual(["config", "G-TEST1"]);
    expect(eventsNamed("page_view")).toHaveLength(0);

    const script = document.querySelector('script[src*="googletagmanager"]');
    expect(script?.getAttribute("src")).toBe("https://www.googletagmanager.com/gtag/js?id=G-TEST1");
  });

  it("URL-encodes a hostile id in the loader src", async () => {
    window.__ROME_RUNTIME_CONFIG__ = { gaMeasurementId: 'G-"><script>alert(1)</script>' };
    const { initAnalytics } = await loadAnalytics();
    initAnalytics();
    const src = document.querySelector('script[src*="googletagmanager"]')?.getAttribute("src");
    expect(src).toBeDefined();
    expect(src).not.toContain("<");
    expect(src).not.toContain('"');
  });

  it("pushes genuine Arguments objects to dataLayer", async () => {
    window.__ROME_RUNTIME_CONFIG__ = { gaMeasurementId: "G-TEST1" };
    const { initAnalytics } = await loadAnalytics();
    initAnalytics();
    for (const entry of window.dataLayer ?? []) {
      expect(Object.prototype.toString.call(entry)).toBe("[object Arguments]");
    }
    expect(window.dataLayer?.length).toBeGreaterThan(0);
  });

  it("emits prefixed custom events for app opens and widget renders", async () => {
    window.__ROME_RUNTIME_CONFIG__ = { gaMeasurementId: "G-TEST1" };
    const { initAnalytics, trackAppOpen, trackWidgetRender } = await loadAnalytics();
    initAnalytics();
    trackAppOpen("morning-brief", "inline");
    trackWidgetRender("morning-brief");
    expect(eventsNamed("rome_app_open")).toEqual([
      ["event", "rome_app_open", { app_id: "morning-brief", surface: "inline" }],
    ]);
    expect(eventsNamed("rome_widget_render")).toEqual([
      ["event", "rome_widget_render", { app_id: "morning-brief" }],
    ]);
  });
});

describe("idle re-engagement", () => {
  it("re-fires one page_view when the tab returns after >=30 hidden minutes", async () => {
    window.__ROME_RUNTIME_CONFIG__ = { gaMeasurementId: "G-TEST1" };
    const { initAnalytics } = await loadAnalytics();
    initAnalytics();

    setVisibility("hidden");
    rs.advanceTimersByTime(31 * 60 * 1000);
    setVisibility("visible");
    expect(eventsNamed("page_view")).toHaveLength(1);
    // Bare event: gtag reads the live document — no path params to sanitize.
    expect(eventsNamed("page_view")[0]).toEqual(["event", "page_view"]);
  });

  it("stays silent for short absences so it can never double an EM view", async () => {
    window.__ROME_RUNTIME_CONFIG__ = { gaMeasurementId: "G-TEST1" };
    const { initAnalytics } = await loadAnalytics();
    initAnalytics();

    setVisibility("hidden");
    rs.advanceTimersByTime(5 * 60 * 1000);
    setVisibility("visible");
    expect(eventsNamed("page_view")).toHaveLength(0);
  });
});
