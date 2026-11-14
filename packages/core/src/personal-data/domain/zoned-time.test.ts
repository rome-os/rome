import { describe, expect, it } from "@rstest/core";
import { fromWallClock, isoInZone, nextPeriod, periodStart } from "./zoned-time.js";

describe("zoned time", () => {
  it("reads a midnight a daylight saving change skips as the instant the skip ends", () => {
    // Chile moves 00:00 to 01:00 on 2026-09-06.
    const skipped = fromWallClock("America/Santiago", 2026, 9, 6);
    expect(isoInZone(skipped, "America/Santiago")).toBe("2026-09-06T01:00:00-03:00");
  });

  it("steps day by day across a skipped midnight", () => {
    const tz = "America/Santiago";
    const days: string[] = [];
    let at = periodStart(fromWallClock(tz, 2026, 9, 5), tz, "day");
    for (let i = 0; i < 3; i += 1) {
      days.push(isoInZone(at, tz).slice(0, 10));
      at = nextPeriod(at, tz, "day");
    }
    expect(days).toEqual(["2026-09-05", "2026-09-06", "2026-09-07"]);
  });

  it("reads a time a change repeats as the first of the two", () => {
    // New York repeats 01:00–02:00 on 2026-11-01.
    const repeated = fromWallClock("America/New_York", 2026, 11, 1, 1, 30);
    expect(isoInZone(repeated, "America/New_York")).toBe("2026-11-01T01:30:00-04:00");
  });
});
