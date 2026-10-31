import { context } from "@opentelemetry/api";
import { describe, expect, it, rs } from "@rstest/core";
import type { InputStatusEvent } from "@rome-os/app-runtime";
import type { AgentTurnHandle, AgentTurnInput } from "./agent-session.js";
import type { ModelSession } from "./agent-runner.js";
import { AgentInputQueue } from "./agent-input-queue.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(steer = rs.fn<ModelSession["steerUserInput"] & {}>().mockResolvedValue("accepted")) {
  const started: AgentTurnInput[] = [];
  const statuses: InputStatusEvent[] = [];
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

function prioritySetup() {
  const started: AgentTurnInput[] = [];
  const statuses: InputStatusEvent[] = [];
  const interrupts: Array<{ turnId: string; reason?: string }> = [];
  const steer = rs.fn<ModelSession["steerUserInput"] & {}>().mockResolvedValue("accepted");
  const queue = new AgentInputQueue(
    (input) => {
      started.push(input);
      const turnId = `turn-${started.length}`;
      return {
        turnId,
        events: { async *[Symbol.asyncIterator]() {} },
        turnContext: context.active(),
        interrupt: async (reason) => {
          interrupts.push({ turnId, reason });
        },
      };
    },
    () => ({ steerUserInput: steer }),
    rs.fn(),
  );
  const submit = (inputId: string, priority?: "now" | "next") =>
    queue.submit(
      { inputId, prompt: inputId },
      {
        priority,
        onTurn: () => {},
        onInputStatus: (status) => {
          statuses.push(status);
        },
      },
    );
  const lastState = (inputId: string) =>
    statuses.filter((status) => status.inputId === inputId).at(-1)?.state;
  return { queue, submit, started, statuses, interrupts, steer, lastState };
}

describe("input priority", () => {
  it("ends the running turn for a now input and never steers it in", async () => {
    const s = prioritySetup();
    s.submit("a");
    await s.queue.beforeSend("turn-1");
    s.queue.ready("turn-1");
    await s.queue.observe({ type: "input_status", inputId: "a", state: "consumed" }, "turn-1");
    const b = s.submit("b", "now");
    await tick();
    expect(b.disposition).toBe("queued");
    expect(s.steer).not.toHaveBeenCalled();
    expect(s.interrupts).toEqual([{ turnId: "turn-1", reason: "superseded" }]);
    s.queue.finish("turn-1");
    // `a` was consumed, so it is in the provider's history and is not repeated.
    expect(s.started.map((input) => input.prompt)).toEqual(["a", "b"]);
  });

  it("carries an input the provider never consumed into the next turn", async () => {
    const s = prioritySetup();
    s.submit("a");
    await s.queue.beforeSend("turn-1");
    s.submit("b", "now");
    s.queue.finish("turn-1");
    expect(s.started.at(-1)).toMatchObject({ inputId: "b", prompt: "a\n\nb" });
    await s.queue.observe({ type: "input_status", inputId: "b", state: "consumed" }, "turn-2");
    expect(s.lastState("a")).toBe("consumed");
    expect(s.statuses.filter((status) => status.inputId === "a").at(-1)?.turnId).toBe("turn-2");
  });

  it("keeps the inputs in order across two supersedes before any is read", async () => {
    const s = prioritySetup();
    s.submit("a");
    s.submit("b", "now");
    s.queue.finish("turn-1");
    expect(s.started.at(-1)?.prompt).toBe("a\n\nb");
    s.submit("c", "now");
    s.queue.finish("turn-2");
    expect(s.started.at(-1)?.prompt).toBe("a\n\nb\n\nc");
  });

  it("answers a burst of now inputs in one turn", async () => {
    const s = prioritySetup();
    s.submit("a", "now");
    s.submit("b", "now");
    s.submit("c", "now");
    expect(s.interrupts).toHaveLength(1);
    s.queue.finish("turn-1");
    expect(s.started.map((input) => input.prompt)).toEqual(["a", "a\n\nb\n\nc"]);
  });

  it("carries an accepted steer that the superseded turn never consumed", async () => {
    const s = prioritySetup();
    s.submit("a");
    s.queue.ready("turn-1");
    await s.queue.observe({ type: "input_status", inputId: "a", state: "consumed" }, "turn-1");
    s.submit("b");
    await tick();
    expect(s.lastState("b")).toBe("accepted");
    s.submit("c", "now");
    s.queue.finish("turn-1");
    expect(s.started.at(-1)?.prompt).toBe("b\n\nc");
  });

  it("keeps a guardian stop from replaying anything", async () => {
    const s = prioritySetup();
    s.submit("a");
    await s.queue.beforeSend("turn-1");
    s.queue.ready("turn-1");
    s.submit("b");
    await tick();
    await s.queue.seal("turn-1");
    s.queue.finish("turn-1");
    await tick();
    expect(s.started).toHaveLength(1);
    expect(s.lastState("a")).toBe("unknown");
  });

  it("replays nothing of a superseded turn the guardian then stops", async () => {
    const s = prioritySetup();
    s.submit("a");
    await s.queue.beforeSend("turn-1");
    s.submit("b", "now");
    s.queue.stop("turn-1");
    s.queue.finish("turn-1");
    await tick();
    // `b` is queued behind the turn, so it still runs, without `a` in front.
    expect(s.started.map((input) => input.prompt)).toEqual(["a", "b"]);
    expect(s.lastState("a")).toBe("unknown");
  });

  it("replays nothing when a now input arrives after the guardian stopped the turn", async () => {
    const s = prioritySetup();
    s.submit("a");
    await s.queue.beforeSend("turn-1");
    s.queue.stop("turn-1");
    s.submit("b", "now");
    // The turn is already ending, so the supersede adds no second interrupt.
    expect(s.interrupts).toEqual([]);
    s.queue.finish("turn-1");
    await tick();
    expect(s.started.map((input) => input.prompt)).toEqual(["a", "b"]);
    expect(s.lastState("a")).toBe("unknown");
  });

  it("ignores a stop for a turn that is not the running one", async () => {
    const s = prioritySetup();
    s.submit("a");
    s.submit("b", "now");
    s.queue.stop("turn-0");
    s.queue.finish("turn-1");
    expect(s.started.at(-1)?.prompt).toBe("a\n\nb");
  });
});
