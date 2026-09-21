import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";
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

void worker
  .start({ onUnhandledRequest: "bypass" })
  .then(() => import("../src/main"))
  .catch((error) => {
    // Without this the page stays blank with no diagnostic when service-worker
    // registration or the app import fails.
    console.error("mock mode failed to start", error);
  });
