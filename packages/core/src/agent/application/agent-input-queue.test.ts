import { context } from "@opentelemetry/api";
import { describe, expect, it, rs } from "@rstest/core";
import type { InputStatusEvent } from "@rome-os/app-runtime";
import type { AgentTurnHandle, AgentTurnInput } from "./agent-session.js";
import type { ModelSession } from "../domain/model-port.js";
import { AgentInputQueue } from "./agent-input-queue.js";

/** A turn that says nothing and never ends; a stop goes to `stop`. */
function fakeHandle(
  id: string,
  stop: (reason?: string) => Promise<void> = async () => {},
): AgentTurnHandle {
  return {
    id,
    hasEnded: false,
    events: () => ({ async *[Symbol.asyncIterator]() {} }),
    ended: () => new Promise(() => {}),
    async stop(reason) {
      await stop(reason);
      return "requested";
    },
    turnContext: context.active(),
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(steer = rs.fn<ModelSession["steerUserInput"] & {}>().mockResolvedValue("accepted")) {
  const started: AgentTurnInput[] = [];
  const statuses: InputStatusEvent[] = [];
  /** The turn each input landed in, by input id. */
  const landedIn: Record<string, string> = {};
  const errors = rs.fn();
  const queue = new AgentInputQueue(
    (input) => {
      started.push(input);
      return fakeHandle(`turn-${started.length}`);
    },
    () => ({ steerUserInput: steer }),
    errors,
  );
  const submit = (inputId: string) => {
    const receipt = queue.submit(
      { inputId, prompt: inputId },
      {
        onInputStatus: (status) => {
          statuses.push(status);
        },
      },
    );
    void receipt.turn.then((turn) => {
      landedIn[inputId] = turn.id;
    });
    return receipt;
  };
  return { queue, submit, started, statuses, landedIn, steer, errors };
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
    // `c` is sent but not yet taken, so it has not landed until the turn ends with it.
    expect(s.landedIn).toEqual({ a: "turn-1", b: "turn-1" });
    s.queue.finish(a.turnId);
    await tick();
    expect(s.landedIn).toEqual({ a: "turn-1", b: "turn-1", c: "turn-1" });
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
    await tick();
    expect(s.landedIn).toEqual({ a: "turn-1", b: "turn-2" });
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
      return fakeHandle(turnId, async (reason) => {
        interrupts.push({ turnId, reason });
      });
    },
    () => ({ steerUserInput: steer }),
    rs.fn(),
  );
  const submit = (inputId: string, priority?: "now" | "next") =>
    queue.submit(
      { inputId, prompt: inputId },
      {
        priority,
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
    expect(b.landed).toBe("queued");
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
});

describe("who an input turn acts for", () => {
  const guardian = { kind: "guardian", userId: "seat" };
  const visitor = { kind: "visitor", accountId: "acct-v" };

  function actorSetup() {
    const startedWith: Array<{ actor?: object }> = [];
    const mixed: string[] = [];
    const steer = rs.fn<ModelSession["steerUserInput"] & {}>().mockResolvedValue("accepted");
    const queue = new AgentInputQueue(
      (_input, options) => {
        startedWith.push(options);
        return fakeHandle(`turn-${startedWith.length}`);
      },
      () => ({ steerUserInput: steer }),
      rs.fn(),
      (turnId) => mixed.push(turnId),
    );
    const submit = (
      inputId: string,
      actor?: { kind: string; userId?: string; accountId?: string },
      priority?: "now",
    ) =>
      queue.submit(
        { inputId, prompt: inputId },
        { ...(actor ? { actor } : {}), ...(priority ? { priority } : {}) },
      );
    return { queue, submit, startedWith, mixed, steer };
  }

  it("marks a running turn mixed when another person's input is steered into it", async () => {
    const s = actorSetup();
    const a = s.submit("a", guardian);
    await s.queue.beforeSend(a.turnId);
    s.queue.ready(a.turnId);
    s.submit("b", { kind: "guardian", userId: "seat" });
    await tick();
    expect(s.mixed).toEqual([]);
    await s.queue.observe({ type: "input_status", inputId: "b", state: "consumed" }, a.turnId);
    s.submit("c", visitor);
    await tick();
    expect(s.steer.mock.calls.map(([input]) => input.inputId)).toEqual(["b", "c"]);
    expect(s.mixed).toEqual([a.turnId]);
  });

  it("starts a turn that bundles two people's inputs as acting for no one", async () => {
    const s = actorSetup();
    const a = s.submit("a", guardian);
    // Two inputs sent "now" stop the running turn and start the next one together.
    s.submit("b", guardian, "now");
    s.submit("c", visitor, "now");
    s.queue.finish(a.turnId);
    await tick();
    expect(s.startedWith).toHaveLength(2);
    expect(s.startedWith[0]?.actor).toBe(guardian);
    expect(s.startedWith[1]).not.toHaveProperty("actor");
  });
});
