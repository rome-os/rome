import { describe, expect, it } from "@rstest/core";
import {
  abbreviateExchange,
  describeExchange,
  type Frame,
  framesOf,
  laneOf,
  stepAt,
  visibleAt,
} from "./frames.js";
import { TRACE_VERSION, type Trace, type TraceEvent, type TraceExchange } from "./trace.js";

const exchange = (path: string, receivedAt: number, answeredAt?: number): TraceExchange => ({
  method: "POST",
  path,
  requestBody: {},
  accepted: false,
  receivedAt,
  ...(answeredAt !== undefined ? { answeredAt } : {}),
});

const event = (lane: TraceEvent["lane"], label: string, at: number): TraceEvent => ({
  at,
  lane,
  label,
});

const message = (id: string, text: string) => ({
  id,
  conversation: "c",
  from: "user" as const,
  text,
  edits: 0,
});

const trace: Trace = {
  version: TRACE_VERSION,
  platform: "telegram",
  conversation: "c",
  steps: [
    {
      label: "write",
      status: "passed",
      startedAt: 0,
      durationMs: 5,
      visible: [message("1", "hi")],
    },
    {
      label: "answer",
      status: "passed",
      startedAt: 10,
      durationMs: 5,
      visible: [message("1", "hi"), message("2", "yo")],
    },
  ],
  exchanges: [exchange("/a", -1, 2), exchange("/b", 10, 12), exchange("/c", 20)],
  changes: [],
  events: [event("agent", "text", 10), event("rome", "create", 11), event("rome", "late", 30)],
  checks: [],
};

const label = (frame: Frame) => {
  if (frame.kind === "step") return frame.step.label;
  return frame.kind === "event" ? frame.event.label : frame.exchange.path;
};

describe("framesOf", () => {
  it("orders every lane on one clock, a step before the events it caused before the requests", () => {
    expect(framesOf(trace).map(label)).toEqual([
      "/a",
      "write",
      "answer",
      "text",
      "/b",
      "create",
      "/c",
      "late",
    ]);
  });
});

describe("laneOf", () => {
  it("puts an event in the lane it was noted for", () => {
    const lanes = framesOf(trace).map((frame) => [label(frame), laneOf(frame)]);
    expect(lanes).toContainEqual(["text", "agent"]);
    expect(lanes).toContainEqual(["create", "rome"]);
    expect(lanes).toContainEqual(["write", "test"]);
    expect(lanes).toContainEqual(["/b", "platform"]);
  });
});

describe("visibleAt", () => {
  const frames = framesOf(trace);
  const at = (name: string) => visibleAt(trace, frames.find((frame) => label(frame) === name)!);

  it("shows a step's own result", () => {
    expect(at("write").after?.label).toBe("write");
  });

  it("shows the result of the step an exchange happened in", () => {
    expect(at("/b").after?.label).toBe("answer");
  });

  it("shows the last earlier step for an exchange between or after steps", () => {
    expect(at("/c").after?.label).toBe("answer");
  });

  it("shows nothing for an exchange before the first step", () => {
    expect(at("/a")).toEqual({ visible: [] });
  });

  it("shows an event what its step shows, as it does an exchange", () => {
    expect(at("text").after?.label).toBe("answer");
    expect(at("late").after?.label).toBe("answer");
  });
});

describe("stepAt", () => {
  it("finds the step running at a moment", () => {
    expect(stepAt(trace, 12)?.label).toBe("answer");
  });

  it("finds the last step that ended before a moment between or after steps", () => {
    expect(stepAt(trace, 7)?.label).toBe("write");
    expect(stepAt(trace, 99)?.label).toBe("answer");
  });

  it("finds none before the first step", () => {
    expect(stepAt(trace, -1)).toBeUndefined();
  });
});

describe("describeExchange", () => {
  it("elides a bot token in the path", () => {
    expect(describeExchange(exchange("/bot123:secret/sendMessage", 0))).toBe(
      "POST /bot…/sendMessage",
    );
  });
});

describe("abbreviateExchange", () => {
  it("keeps the method and the last segment that is not an id", () => {
    expect(abbreviateExchange(exchange("/api/v10/channels/100/messages/101", 0))).toBe(
      "POST …/messages",
    );
    expect(abbreviateExchange(exchange("/bot123:secret/editMessageText", 0))).toBe(
      "POST …/editMessageText",
    );
  });
});
