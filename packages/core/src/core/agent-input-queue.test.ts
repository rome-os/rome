import { context } from "@opentelemetry/api";
import { describe, expect, it, rs } from "@rstest/core";
import type { InputStatusMessage } from "@rome-os/app-runtime";
import type { AgentTurnHandle, AgentTurnInput } from "./agent-session.js";
import { AgentInputQueue } from "./agent-input-queue.js";

function setup() {
  const started: AgentTurnInput[] = [];
  const statuses: InputStatusMessage[] = [];
  const handles: AgentTurnHandle[] = [];
  const errors = rs.fn();
  const queue = new AgentInputQueue((input) => {
    started.push(input);
    return {
      turnId: `caller-${started.length}`,
      events: { async *[Symbol.asyncIterator]() {} },
      turnContext: context.active(),
    };
  }, errors);
  const submit = (inputId: string) =>
    queue.submit(
      { inputId, prompt: inputId },
      {
        onTurn: (handle) => handles.push(handle),
        onInputStatus: (status) => {
          statuses.push(status);
        },
      },
    );
  return { queue, submit, started, statuses, handles, errors };
}

describe("conversational input lane", () => {
  it("sends every input through and leaves model-turn ownership to the provider", async () => {
    const s = setup();
    const a = s.submit("a");
    const b = s.submit("b");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(a).toEqual({ inputId: "a", turnId: null, disposition: "sent" });
    expect(b).toEqual({ inputId: "b", turnId: null, disposition: "sent" });
    expect(s.started.map((input) => input.inputId)).toEqual(["a", "b"]);
    expect(s.handles).toHaveLength(2);
    expect(s.statuses).toEqual([
      { type: "input_status", inputId: "a", state: "sent" },
      { type: "input_status", inputId: "b", state: "sent" },
    ]);
  });

  it("records read and answered only from provider-owned boundaries", async () => {
    const s = setup();
    s.submit("a");
    await s.queue.observe({ type: "input_status", inputId: "a", state: "read" }, "sdk-turn");
    await s.queue.answer("a", "sdk-turn");

    expect(s.statuses).toEqual([
      { type: "input_status", inputId: "a", state: "sent" },
      { type: "input_status", inputId: "a", state: "read", turnId: "sdk-turn" },
      { type: "input_status", inputId: "a", state: "answered", turnId: "sdk-turn" },
    ]);
  });

  it("returns an echoed completion when the submission belongs to a prior process", async () => {
    const s = setup();
    await expect(s.queue.answer("restored", "sdk-restored")).resolves.toEqual({
      type: "input_status",
      inputId: "restored",
      turnId: "sdk-restored",
      state: "answered",
    });
    expect(s.statuses).toEqual([]);
  });

  it("preserves an answered middleware completion instead of downgrading it to read", async () => {
    const s = setup();
    s.submit("a");
    await s.queue.observe({ type: "input_status", inputId: "a", state: "answered" }, "scripted");
    expect(s.statuses.at(-1)).toEqual({
      type: "input_status",
      inputId: "a",
      turnId: "scripted",
      state: "answered",
    });
  });

  it("deduplicates input identities and rejects new input after close", () => {
    const s = setup();
    s.submit("a");
    s.submit("a");
    expect(s.started).toHaveLength(1);
    s.queue.close();
    expect(() => s.submit("b")).toThrow("closed");
  });
});
