// Ties sessions to Rome's OpenTelemetry traces and session-scoped logs.

import { enterSession } from "../../telemetry-context.js";
import { startRomeSpan, withRomeSpan } from "../../telemetry.js";
import type { SessionTracing } from "../application/session-tracing.js";

export const romeSessionTracing: SessionTracing = {
  startSpan: startRomeSpan,
  withSpan: withRomeSpan,
  enterSession,
};
