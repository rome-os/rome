import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";
import { renderApp } from "../src/main";
import "./embedded-tour.css";

if (
  window.parent !== window &&
  ["chat", "build", "apps"].includes(new URLSearchParams(window.location.search).get("tour") ?? "")
) {
  document.documentElement.dataset.embeddedTour = "true";
}

// Register the interception worker before the app boots, so the AuthGate's
// very first /api/health + /api/bootstrap probes are already answered by
// fixtures. Unhandled requests fall through to the dev-server proxy (a real
// backend, when one is running) untouched.
const worker = setupWorker(...handlers);

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
