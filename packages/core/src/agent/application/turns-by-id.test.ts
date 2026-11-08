import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { createTurn } from "../domain/turn.js";
import { createTurnsById } from "./turns-by-id.js";

describe("createTurnsById", () => {
  afterEach(() => {
    rs.useRealTimers();
  });

  it("finds a turn from its start until the kept time after it ends", async () => {
    rs.useFakeTimers();
    const turns = createTurnsById(1_000);
    const { turn, writer } = createTurn("turn-1", null);
    turns.add(turn);
    expect(turns.find("turn-1")).toBe(turn);

    writer.end({ stoppedByRome: false });
    await turn.ended();
    await Promise.resolve();
    rs.advanceTimersByTime(999);
    expect(turns.find("turn-1")).toBe(turn);
    rs.advanceTimersByTime(1);
    expect(turns.find("turn-1")).toBeUndefined();
  });

  it("finds no turn it was not given", () => {
    expect(createTurnsById().find("turn-1")).toBeUndefined();
  });
});
