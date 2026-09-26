import { describe, expect, it } from "@rstest/core";
import {
  clampPillPosition,
  defaultPillPosition,
  isPillEnabled,
  parseAgentName,
  parsePillPosition,
  supportsFloatingPill,
} from "./floating-pill-state";

const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };
const SIZE = { width: 160, height: 56 };

describe("parseAgentName", () => {
  it("returns the trimmed agent name", () => {
    expect(parseAgentName({ agentName: "  JessieRome " })).toBe("JessieRome");
  });

  it("returns null when the instance never set one", () => {
    // Instances onboarded before agentName existed return a settings map
    // without the key, and the pill falls back to "Rome".
    expect(parseAgentName({ guardianName: "Jessie" })).toBeNull();
    expect(parseAgentName({ agentName: "   " })).toBeNull();
    expect(parseAgentName(null)).toBeNull();
  });
});

describe("isPillEnabled", () => {
  it("is off until someone turns it on", () => {
    expect(isPillEnabled(null)).toBe(false);
    expect(isPillEnabled("false")).toBe(false);
    expect(isPillEnabled("true")).toBe(true);
  });
});

describe("parsePillPosition", () => {
  it("reads a stored position", () => {
    expect(parsePillPosition('{"x":100,"y":200}')).toEqual({ x: 100, y: 200 });
  });

  it("returns null for anything else, so the default position is used", () => {
    expect(parsePillPosition(null)).toBeNull();
    expect(parsePillPosition("not json")).toBeNull();
  });

  it("refuses a number the window APIs would throw on", () => {
    // They throw during bootstrap, and bootstrap quits on a throw — a stored
    // value like this would keep Rome from starting at all.
    expect(parsePillPosition('{"x":1e400,"y":0}')).toBeNull();
    expect(parsePillPosition('{"x":0,"y":1e300}')).toBeNull();
  });

  it("rounds, because the window APIs take whole points", () => {
    expect(parsePillPosition('{"x":100.4,"y":200.6}')).toEqual({ x: 100, y: 201 });
  });
});

describe("supportsFloatingPill", () => {
  it("is on for macOS up to 26, which is Darwin 25", () => {
    expect(supportsFloatingPill("darwin", "25.5.0")).toBe(true);
    expect(supportsFloatingPill("darwin", "24.6.0")).toBe(true);
  });

  it("is off from macOS 27, where clicking a panel activates the app", () => {
    expect(supportsFloatingPill("darwin", "26.0.0")).toBe(false);
    expect(supportsFloatingPill("darwin", "27.1.0")).toBe(false);
  });

  it("is off everywhere else", () => {
    expect(supportsFloatingPill("win32", "10.0.26100")).toBe(false);
    expect(supportsFloatingPill("linux", "6.8.0")).toBe(false);
  });
});

describe("defaultPillPosition", () => {
  it("sits in the bottom-right corner of the work area with a margin", () => {
    expect(defaultPillPosition(WORK_AREA, SIZE)).toEqual({
      x: 1440 - 160 - 24,
      y: 25 + 875 - 56 - 24,
    });
  });
});

describe("clampPillPosition", () => {
  it("leaves a position inside the work area alone", () => {
    expect(clampPillPosition({ x: 300, y: 300 }, SIZE, WORK_AREA)).toEqual({ x: 300, y: 300 });
  });

  it("pulls the pill out from under the menu bar and back from the left edge", () => {
    expect(clampPillPosition({ x: -50, y: 0 }, SIZE, WORK_AREA)).toEqual({ x: 0, y: 25 });
  });

  it("pulls the pill back onto the screen after an external display is unplugged", () => {
    expect(clampPillPosition({ x: 5000, y: 5000 }, SIZE, WORK_AREA)).toEqual({
      x: 1440 - 160,
      y: 25 + 875 - 56,
    });
  });
});
