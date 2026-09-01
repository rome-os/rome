import { context } from "@opentelemetry/api";
import { describe, expect, it, rs } from "@rstest/core";
import type { InputStatusMessage } from "@rome-os/app-runtime";
import type { AgentTurnHandle, AgentTurnInput } from "./agent-session.js";
import type { ModelSession } from "./agent-runner.js";
import { AgentInputQueue } from "./agent-input-queue.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(steer = rs.fn<ModelSession["steerUserInput"] & {}>().mockResolvedValue("accepted")) {
  const started: AgentTurnInput[] = [];
  const statuses: InputStatusMessage[] = [];
  const handles: AgentTurnHandle[] = [];
  const errors = rs.fn();
  const queue = new AgentInputQueue(
    (input) => {
      started.push(input);
      return {
        turnId: `turn-${started.length}`,
        events: { async *[Symbol.asyncIterator]() {} },
        turnContext: context.active(),
      };
    },
    () => ({ steerUserInput: steer }),
    errors,
  );
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
  return { queue, submit, started, statuses, handles, steer, errors };
}

describe("conversational input lane", () => {
  it("reserves one turn before async startup, then steers in submission order", async () => {
    const s = setup();
    const a = s.submit("a");
    const b = s.submit("b");
    s.submit("c");
    expect(b.turnId).toBe(a.turnId);
    expect(s.started).toHaveLength(1);
    expect(s.steer).not.toHaveBeenCalled();
    await s.queue.beforeSend(a.turnId);
    s.queue.ready(a.turnId);
    await tick();
    expect(s.steer.mock.calls.map(([input]) => input.inputId)).toEqual(["b"]);
    await s.queue.observe({ type: "input_status", inputId: "b", state: "consumed" }, a.turnId);
    await tick();
    expect(s.steer.mock.calls.map(([input]) => input.inputId)).toEqual(["b", "c"]);
    expect(s.handles).toHaveLength(1);
  });

  it("adopts a provider-retained late input under a new turn and the same input id", async () => {
    const s = setup();
    s.submit("a");
    s.queue.ready("turn-1");
    s.submit("b");
    await tick();
    await s.queue.observe({ type: "input_status", inputId: "b", state: "queued" }, "turn-1");
    await s.queue.seal("turn-1");
    s.queue.finish("turn-1");
    expect(s.started.map((input) => input.inputId)).toEqual(["a", "b"]);
    expect(s.handles.map((handle) => handle.turnId)).toEqual(["turn-1", "turn-2"]);
    await tick();
    expect(s.statuses.at(-1)).toMatchObject({ inputId: "b", turnId: "turn-2", state: "queued" });
  });

  it("does not replay an accepted but unconfirmed input at the terminal boundary", async () => {
    const s = setup();
    s.submit("a");
    s.queue.ready("turn-1");
    s.submit("b");
    await tick();
    await s.queue.seal("turn-1");
    s.queue.finish("turn-1");
    await tick();
    expect(s.started).toHaveLength(1);
    expect(s.statuses.filter((status) => status.inputId === "b").at(-1)).toMatchObject({
      inputId: "b",
      state: "unknown",
    });
  });

  it("falls back only on definite rejection, including rejection racing completion", async () => {
    let reject!: (value: "deferred") => void;
    const s = setup(
      rs.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            reject = resolve;
          }),
      ),
    );
    s.submit("a");
    s.queue.ready("turn-1");
    s.submit("b");
    s.submit("c");
    await tick();
    const seal = s.queue.seal("turn-1");
    reject("deferred");
    await seal;
    s.queue.finish("turn-1");
    expect(s.started.map((input) => input.inputId)).toEqual(["a", "b"]);
  });

  it("does not replay a transport failure whose delivery is unknown", async () => {
    const s = setup(rs.fn().mockRejectedValue(new Error("timeout")));
    s.submit("a");
    s.queue.ready("turn-1");
    s.submit("b");
    await tick();
    await s.queue.seal("turn-1");
    s.queue.finish("turn-1");
    expect(s.started).toHaveLength(1);
    expect(s.errors).toHaveBeenCalledOnce();
    expect(s.statuses.at(-1)).toMatchObject({ inputId: "b", state: "unknown" });
  });

  it("deduplicates repeated submissions and closes without launching queued work", async () => {
    const s = setup();
    s.submit("a");
    s.submit("a");
    s.submit("b");
    s.queue.close();
    s.queue.finish("turn-1");
    await tick();
    expect(s.started).toHaveLength(1);
    expect(s.statuses.at(-1)).toMatchObject({ inputId: "b", state: "cancelled" });
    expect(() => s.submit("c")).toThrow("closed");
  });
});
