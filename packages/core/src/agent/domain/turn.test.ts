import { describe, expect, it } from "@rstest/core";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import { createTurn } from "./turn.js";

const text = (value: string) => ({ type: "text", text: value }) as unknown as StreamAgentEvent;

async function readAll(events: AsyncIterable<StreamAgentEvent>): Promise<StreamAgentEvent[]> {
  const read: StreamAgentEvent[] = [];
  for await (const event of events) read.push(event);
  return read;
}

describe("Turn", () => {
  it("gives every reader every event from the start, in order", async () => {
    const { turn, writer } = createTurn("t1", null);
    writer.record(text("a"));
    const early = readAll(turn.events());
    writer.record(text("b"));
    const late = readAll(turn.events());
    writer.record(text("c"));
    writer.end({ stoppedByRome: false });

    expect(await early).toEqual([text("a"), text("b"), text("c")]);
    expect(await late).toEqual([text("a"), text("b"), text("c")]);
    expect(await readAll(turn.events())).toEqual([text("a"), text("b"), text("c")]);
  });

  it("ends once, and keeps no event after its ending", async () => {
    const { turn, writer } = createTurn("t1", null);
    expect(turn.hasEnded).toBe(false);
    writer.end({ stoppedByRome: true });
    writer.end({ stoppedByRome: false });
    writer.record(text("late"));

    expect(turn.hasEnded).toBe(true);
    expect(await turn.ended()).toEqual({ stoppedByRome: true });
    expect(await readAll(turn.events())).toEqual([]);
  });

  it("carries a stop to the model session while the turn runs", async () => {
    const reasons: string[] = [];
    const { turn } = createTurn("t1", async (reason) => {
      reasons.push(reason ?? "");
    });

    expect(await turn.stop("user-stop")).toBe("requested");
    expect(reasons).toEqual(["user-stop"]);
  });

  it("does nothing when stopped after its ending", async () => {
    const reasons: string[] = [];
    const { turn, writer } = createTurn("t1", async (reason) => {
      reasons.push(reason ?? "");
    });
    writer.end({ stoppedByRome: false });

    expect(await turn.stop("user-stop")).toBe("ended");
    expect(reasons).toEqual([]);
  });

  it("refuses a stop when it cannot be stopped", async () => {
    const { turn } = createTurn("fork", null);
    expect(await turn.stop("user-stop")).toBe("cannot_stop");
    expect(turn.hasEnded).toBe(false);
  });
});
