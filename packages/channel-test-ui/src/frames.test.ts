import { describe, expect, it } from "@rstest/core";
import { abbreviateExchange, describeExchange, type Frame, framesOf, visibleAt } from "./frames.js";
import type { Trace, TraceExchange } from "./trace.js";

const exchange = (path: string, receivedAt: number, answeredAt?: number): TraceExchange => ({
  method: "POST",
  path,
  requestBody: {},
  accepted: false,
  receivedAt,
  ...(answeredAt !== undefined ? { answeredAt } : {}),
});

const message = (id: string, text: string) => ({
  id,
  conversation: "c",
  from: "user" as const,
  text,
  edits: 0,
});

const trace: Trace = {
  version: 1,
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
};

const label = (frame: Frame) => (frame.kind === "step" ? frame.step.label : frame.exchange.path);

describe("framesOf", () => {
  it("orders both lanes on one clock, the step first when they tie", () => {
    expect(framesOf(trace).map(label)).toEqual(["/a", "write", "answer", "/b", "/c"]);
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
