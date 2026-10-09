import type { Trace, TraceEvent, TraceExchange, TraceMessage, TraceStep } from "./trace.js";

/**
 * One row of a trace's timeline, in one of four lanes: a test step, something
 * the agent emitted, something Rome did, or a request the platform received.
 * Each carries milliseconds since the scenario started.
 */
export type Frame =
  | { kind: "step"; at: number; step: TraceStep }
  | { kind: "event"; at: number; event: TraceEvent }
  | { kind: "exchange"; at: number; exchange: TraceExchange };

export type Lane = "test" | "agent" | "rome" | "platform";

export function laneOf(frame: Frame): Lane {
  if (frame.kind === "step") return "test";
  return frame.kind === "event" ? frame.event.lane : "platform";
}

/** Every frame in time order. At the same moment a step sorts before the
 *  events it caused, and those before the requests that follow. */
export function framesOf(trace: Trace): Frame[] {
  const frames: Frame[] = [
    ...trace.steps.map((step): Frame => ({ kind: "step", at: step.startedAt, step })),
    ...trace.events.map((event): Frame => ({ kind: "event", at: event.at, event })),
    ...trace.exchanges.map(
      (exchange): Frame => ({ kind: "exchange", at: exchange.receivedAt, exchange }),
    ),
  ];
  const causeFirst = (frame: Frame) => ({ step: 0, event: 1, exchange: 2 })[frame.kind];
  return frames.sort((a, b) => a.at - b.at || causeFirst(a) - causeFirst(b));
}

/**
 * What the conversation shows for `frame`: after its step, or after the step
 * an event or exchange happened in. One outside every step shows the state the
 * last earlier step left, and one before any step shows nothing yet.
 */
export function visibleAt(
  trace: Trace,
  frame: Frame,
): { after?: TraceStep; visible: TraceMessage[] } {
  const step = frame.kind === "step" ? frame.step : stepAt(trace, frame.at);
  return step ? { after: step, visible: step.visible } : { visible: [] };
}

/** The step running at `at` milliseconds, else the last one that ended before it. */
export function stepAt(trace: Trace, at: number): TraceStep | undefined {
  return (
    trace.steps.find((s) => s.startedAt <= at && at <= s.startedAt + s.durationMs) ??
    trace.steps.filter((s) => s.startedAt + s.durationMs <= at).at(-1)
  );
}

/** A request's method and path, with a bot token in the path elided. */
export function describeExchange(exchange: TraceExchange): string {
  return `${exchange.method} ${exchange.path.replace(/\/bot[^/]+\//, "/bot…/")}`;
}

/** A request in a few characters: its method and the last path segment that
 *  is not an id, such as `POST …/editMessageText`. */
export function abbreviateExchange(exchange: TraceExchange): string {
  const named = exchange.path.split("/").filter((segment) => segment && !/^\d+$/.test(segment));
  return `${exchange.method} …/${named.at(-1) ?? ""}`;
}
