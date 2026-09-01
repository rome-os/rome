import { describe, expect, it } from "@rstest/core";
import {
  ADVANCED_EASTER_EGG_INITIAL_SEQUENCE,
  advanceAdvancedEasterEggSequence,
  type AdvancedEasterEggSequenceState,
} from "./advanced-easter-egg";

describe("advanceAdvancedEasterEggSequence", () => {
  it("unlocks after five option presses followed by two shift presses", () => {
    const result = press(["Alt", "Alt", "Alt", "Alt", "Alt", "Shift", "Shift"]);

    expect(result.unlocked).toBe(true);
    expect(result.state).toEqual(ADVANCED_EASTER_EGG_INITIAL_SEQUENCE);
  });

  it("does not count repeated keydown events", () => {
    let state = ADVANCED_EASTER_EGG_INITIAL_SEQUENCE;

    for (let i = 0; i < 5; i += 1) {
      state = advanceAdvancedEasterEggSequence(state, { key: "Alt" }).state;
    }

    const repeatedShift = advanceAdvancedEasterEggSequence(state, { key: "Shift", repeat: true });
    const finalShift = advanceAdvancedEasterEggSequence(repeatedShift.state, { key: "Shift" });

    expect(finalShift.unlocked).toBe(false);
    expect(finalShift.state).toEqual({ phase: "shift", count: 1 });
  });

  it("resets when another key interrupts the sequence", () => {
    const result = press(["Alt", "Alt", "Escape", "Alt", "Alt", "Alt", "Alt", "Shift", "Shift"]);

    expect(result.unlocked).toBe(false);
    expect(result.state).toEqual(ADVANCED_EASTER_EGG_INITIAL_SEQUENCE);
  });

  it("treats Option key labels as option presses", () => {
    const result = press(["Option", "Option", "Option", "Option", "Option", "Shift", "Shift"]);

    expect(result.unlocked).toBe(true);
  });
});

function press(keys: string[]): { state: AdvancedEasterEggSequenceState; unlocked: boolean } {
  return keys.reduce((result, key) => advanceAdvancedEasterEggSequence(result.state, { key }), {
    state: ADVANCED_EASTER_EGG_INITIAL_SEQUENCE,
    unlocked: false,
  });
}
