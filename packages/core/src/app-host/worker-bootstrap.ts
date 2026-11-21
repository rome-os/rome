// OpenTelemetry auto-instrumentation must be registered before modules such as
// pg are loaded. Keep the worker entrypoint tiny and dynamically import the
// runtime only after telemetry has installed its hooks.
import { initTelemetry } from "../telemetry.js";

initTelemetry();
await import("./worker.js");
