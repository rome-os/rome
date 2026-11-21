import { describe, expect, it } from "@rstest/core";
import type { AgentInputState } from "@rome-os/app-runtime";
import {
  afterLanding,
  arrive,
  canSteer,
  carryOver,
  endTurn,
  isQueueInput,
  joinPrompts,
  markReady,
  nextInput,
  NOTHING_CARRIED,
  INTERRUPTED_WORK_NOTE,
  NEW_INPUT_NOTE,
  retain,
  seal,
  steer,
  steerOutcome,
  startTurn,
  supersede,
  type InputPriority,
} from "./input-queue.js";

interface Input {
  name: string;
  priority: InputPriority;
  state: AgentInputState;
}

const input = (name: string, priority: InputPriority = "next", state: AgentInputState = "queued") =>
  ({ name, priority, state }) as Input;
const names = (inputs: readonly Input[]) => inputs.map((i) => i.name);

describe("after inputs", () => {
  it("start a turn of their own, queued behind a running one, outside the input queue", () => {
    expect(afterLanding(false)).toBe("started");
    expect(afterLanding(true)).toBe("queued");
    expect(isQueueInput("after")).toBe(false);
    expect(isQueueInput("next")).toBe(true);
    expect(isQueueInput("now")).toBe(true);
  });
});

describe("arrive", () => {
  it("starts a turn when none runs", () => {
    expect(arrive(undefined, "now")).toEqual({ landing: "started", supersede: false });
    expect(arrive(undefined, "next")).toEqual({ landing: "started", supersede: false });
  });

  it("steers a next input into a ready turn and queues it otherwise", () => {
    const { turn } = startTurn(input("a"), [], NOTHING_CARRIED);
    expect(arrive(turn, "next").landing).toBe("queued");
    expect(arrive(markReady(turn), "next").landing).toBe("steered");
    expect(arrive(seal(markReady(turn)), "next").landing).toBe("queued");
  });

  it("supersedes the running turn once for now inputs", () => {
    const { turn } = startTurn(input("a"), [], NOTHING_CARRIED);
    expect(arrive(markReady(turn), "now")).toEqual({ landing: "queued", supersede: true });
    expect(arrive(supersede(turn), "now")).toEqual({ landing: "queued", supersede: false });
  });
});

describe("startTurn", () => {
  it("puts carried inputs in front and absorbs queued now inputs into a now turn", () => {
    const queued = [input("b"), input("c", "now"), input("d", "now")];
    const { turn, queued: rest } = startTurn(input("a", "now"), queued, {
      inputs: [input("x")],
      interrupted: [],
    });
    expect(names(turn.prompted)).toEqual(["x", "a", "c", "d"]);
    expect(names(turn.bound)).toEqual(["x", "c", "d"]);
    expect(names(rest)).toEqual(["b"]);
  });

  it("leaves the queue alone for a next turn", () => {
    const { turn, queued } = startTurn(input("a"), [input("b", "now")], NOTHING_CARRIED);
    expect(names(turn.prompted)).toEqual(["a"]);
    expect(names(queued)).toEqual(["b"]);
  });
});

describe("joinPrompts", () => {
  it("keeps a single input as it is and joins several into one prompt", () => {
    const a = { prompt: "a", images: ["1"] };
    expect(joinPrompts(a, [a])).toBe(a);
    expect(joinPrompts(a, [{ prompt: "x" }, a])).toEqual({ prompt: "x\n\na", images: ["1"] });
  });

  it("names interrupted work ahead of the new input, with its images", () => {
    const a = { prompt: "a", images: ["1"] };
    expect(joinPrompts(a, [a], [{ prompt: "w", images: ["0"] }])).toEqual({
      prompt: `${INTERRUPTED_WORK_NOTE}\n\nw\n\n${NEW_INPUT_NOTE}\n\na`,
      images: ["0", "1"],
    });
  });
});

describe("steering", () => {
  it("steers one input at a time into a ready, unsealed turn", () => {
    const b = input("b");
    const { turn } = startTurn(input("a"), [], NOTHING_CARRIED);
    expect(canSteer(turn)).toBe(false);
    const steered = steer(markReady(turn), b);
    expect(canSteer(steered)).toBe(false);
    expect(steered.pending).toBe(b);
    expect(canSteer(markReady(supersede(turn)))).toBe(false);
  });

  it("queues a retained input once, in front, and seals the turn", () => {
    const b = input("b");
    const { turn } = startTurn(input("a"), [], NOTHING_CARRIED);
    const retained = retain(steer(markReady(turn), b), b, [input("c")]);
    expect(retained.turn.sealed).toBe(true);
    expect(retained.turn.pending).toBeUndefined();
    expect(names(retained.queued)).toEqual(["b", "c"]);
    expect(names(retain(turn, b, retained.queued).queued)).toEqual(["b", "c"]);
  });

  it("reads a steer's answer", () => {
    expect(steerOutcome("submitted", "accepted")).toBe("accepted");
    expect(steerOutcome("submitted", "deferred")).toBe("deferred");
    expect(steerOutcome("consumed", "deferred")).toBe("settled");
  });
});

describe("ending a turn", () => {
  it("carries over what a superseded turn's provider never consumed, in prompt order", () => {
    const x = input("x", "next", "submitted");
    const a = input("a", "now", "consumed");
    const s = input("s", "next", "accepted");
    const q = input("q", "next", "queued");
    let { turn } = startTurn(a, [], { inputs: [x], interrupted: [] });
    turn = steer(steer(markReady(turn), s), q);
    expect(names(carryOver(supersede(turn), [q], false).inputs)).toEqual(["x", "s"]);
  });

  it("hands on the consumed inputs of an unfinished superseded turn as interrupted work, each once", () => {
    const w = input("w", "now", "consumed");
    const a = input("a", "now", "consumed");
    const s = input("s", "next", "consumed");
    let { turn } = startTurn(a, [], { inputs: [], interrupted: [w, a] });
    turn = steer(markReady(turn), s);
    expect(names(carryOver(supersede(turn), [], false).interrupted)).toEqual(["w", "a", "s"]);
  });

  it("hands on no interrupted work from a turn that completed", () => {
    const w = input("w", "now", "consumed");
    const { turn } = startTurn(input("a", "now", "consumed"), [], { inputs: [], interrupted: [w] });
    expect(carryOver(supersede(turn), [], true).interrupted).toEqual([]);
  });

  it("marks unconfirmed inputs unknown and unretained queued ones failed", () => {
    const a = input("a", "next", "submitted");
    const b = input("b", "next", "accepted");
    const { turn } = startTurn(a, [], NOTHING_CARRIED);
    expect(endTurn(steer(markReady(turn), b), []).map(([i, s]) => [i.name, s])).toEqual([
      ["a", "unknown"],
      ["b", "unknown"],
    ]);
    const c = input("c");
    expect(
      endTurn(startTurn(c, [], NOTHING_CARRIED).turn, []).map(([i, s]) => [i.name, s]),
    ).toEqual([["c", "failed"]]);
    expect(endTurn(startTurn(c, [], NOTHING_CARRIED).turn, [c])).toEqual([]);
  });

  it("starts the next turn from the queue before the carried inputs", () => {
    const carried = (...inputs: Input[]) => ({ inputs, interrupted: [input("w")] });
    expect(nextInput([input("q")], carried(input("c"))).next?.name).toBe("q");
    expect(nextInput([], carried(input("c"))).next?.name).toBe("c");
    expect(nextInput([], carried()).next).toBeUndefined();
  });
});
