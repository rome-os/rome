// Ties sessions to Rome's OpenTelemetry traces and session-scoped logs.
// It implements the application layer's `SessionTracing` port. It doesn't
// import the port, because infrastructure imports only the domain; the
// session manager's deps check its shape where it is wired.

import { enterSession } from "../../telemetry-context.js";
import { startRomeSpan, withRomeSpan } from "../../telemetry.js";

export const romeSessionTracing = {
  startSpan: startRomeSpan,
  withSpan: withRomeSpan,
  enterSession,
};
