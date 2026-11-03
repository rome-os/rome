import { HttpResponse, http } from "msw";
import { setupWorker } from "msw/browser";
import { handlers, strictE2eHandlers } from "./handlers";
import { renderApp } from "../src/main";
import "./embedded-tour.css";

if (
  window.parent !== window &&
  ["chat", "build", "apps"].includes(new URLSearchParams(window.location.search).get("tour") ?? "")
) {
  document.documentElement.dataset.embeddedTour = "true";
  // The host page owns focus until the visitor interacts with the demo.
  // Otherwise an autofocus here, like the empty-chat composer's, moves
  // keyboard focus into this frame on load and scrolls the host page down to
  // it. The frame's `inert` doesn't stop that in Chrome across origins.
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (options) {
    if (navigator.userActivation?.hasBeenActive) focus.call(this, options);
  };
}

// Register the interception worker before the app boots, so the AuthGate's
// very first /api/health + /api/bootstrap probes are already answered by
// fixtures. Strict E2E mode also blocks external requests and unmocked API
// routes. Ordinary mock mode keeps the backend proxy and recorded-app assets.
const strictE2e = import.meta.env.ROME_MOCK_STRICT_E2E;
const worker = setupWorker(
  ...(strictE2e
    ? [
        http.all("*", ({ request }) => {
          if (new URL(request.url).origin !== window.location.origin) return HttpResponse.error();
        }),
      ]
    : []),
  ...handlers,
  ...(strictE2e ? strictE2eHandlers : []),
);

void (async () => {
  try {
    await worker.start({ onUnhandledRequest: "bypass" });
    // renderApp is a static import above, so the app lives on the main chunk
    // and keeps Fast Refresh. Rendering only after the worker is ready keeps
    // the "worker before first request" guarantee the previous dynamic import
    // provided, without isolating the app in an async chunk where React Fast
    // Refresh's $RefreshReg$ global is never established (rome-os/rome#383).
    renderApp();
  } catch (error) {
    // Without this the page stays blank with no diagnostic when service-worker
    // registration or the app import fails.
    console.error("mock mode failed to start", error);
  }
})();
