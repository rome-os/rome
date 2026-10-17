// The trace format lives with the scenarios that write it, in core's test kit.
// This is the one place the UI reaches for it.
export {
  TRACE_VERSION,
  type Trace,
  type TraceChange,
  type TraceCheck,
  type TraceEvent,
  type TraceExchange,
  type TraceIndex,
  type TraceMessage,
  type TraceStep,
  traceIndexSchema,
  traceSchema,
} from "@rome/core/src/test/kit/im/trace.js";
