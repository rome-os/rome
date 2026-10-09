import type { Trace, TraceExchange, TraceMessage, TraceStep } from "./trace.js";

/**
 * One row of a trace's timeline, in one of two lanes: a test step, or a request
 * the platform received. Each carries milliseconds since the scenario started.
 */
export type Frame =
  | { kind: "step"; at: number; step: TraceStep }
  | { kind: "exchange"; at: number; exchange: TraceExchange };

export type Lane = "test" | "platform";

export function laneOf(frame: Frame): Lane {
  return frame.kind === "step" ? "test" : "platform";
}

/** Every frame in time order. At the same moment the step sorts first, since
 *  the requests are its effect. */
export function framesOf(trace: Trace): Frame[] {
  const frames: Frame[] = [
    ...trace.steps.map((step): Frame => ({ kind: "step", at: step.startedAt, step })),
    ...trace.exchanges.map(
      (exchange): Frame => ({ kind: "exchange", at: exchange.receivedAt, exchange }),
    ),
  ];
  const causeFirst = (frame: Frame) => (frame.kind === "step" ? 0 : 1);
  return frames.sort((a, b) => a.at - b.at || causeFirst(a) - causeFirst(b));
}

/**
 * What the conversation shows for `frame`: after its step, or after the step
 * an exchange happened in. An exchange outside every step shows the state the
 * last earlier step left, and one before any step shows nothing yet.
 */
export function visibleAt(
  trace: Trace,
  frame: Frame,
): { after?: TraceStep; visible: TraceMessage[] } {
  const step =
    frame.kind === "step"
      ? frame.step
      : (trace.steps.find(
          (s) => s.startedAt <= frame.at && frame.at <= s.startedAt + s.durationMs,
        ) ?? trace.steps.filter((s) => s.startedAt + s.durationMs <= frame.at).at(-1));
  return step ? { after: step, visible: step.visible } : { visible: [] };
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
