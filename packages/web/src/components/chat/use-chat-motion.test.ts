import { describe, expect, it } from "@rstest/core";
import { clampFlight } from "./use-chat-motion";

describe("clampFlight", () => {
  it("leaves a short flight from the composer untouched", () => {
    expect(clampFlight(-12, 96, 120)).toEqual({ x: -12, y: 96 });
  });

  it("shortens a first-message flight to the cap, keeping its direction", () => {
    const flight = clampFlight(30, 600, 120);
    expect(Math.hypot(flight.x, flight.y)).toBeCloseTo(120);
    expect(flight.x / flight.y).toBeCloseTo(30 / 600);
  });
});
