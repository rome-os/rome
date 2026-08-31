import { describe, expect, it, afterEach, rs } from "@rstest/core";
import type { TFunction } from "i18next";
import { dayLabel, startOfDay } from "./format";

// Day grouping on the person timeline. The labels are calendar answers, so the
// cases that matter are the ones where a calendar day is not 24 hours long.

const t = ((key: string) => key) as unknown as TFunction<"people">;

/** Noon on a given local date — far enough from either boundary that the test
 *  is about the label, not about rounding. */
function localNoon(year: number, month: number, day: number): number {
  return Math.floor(new Date(year, month - 1, day, 12, 0, 0).getTime() / 1000);
}

describe("dayLabel", () => {
  afterEach(() => {
    rs.useRealTimers();
  });

  it("carries the year only once a date needs it to be unambiguous", () => {
    rs.useFakeTimers().setSystemTime(new Date(2026, 5, 10, 9, 0, 0));
    // Inside this year the shorter label is unambiguous, so it stays short.
    expect(dayLabel(t, startOfDay(localNoon(2026, 3, 5)), "en")).toBe("Mar 5");
    // Past it, a timeline paging backwards reaches days that share a label
    // with days in every other year.
    expect(dayLabel(t, startOfDay(localNoon(2024, 3, 5)), "en")).toBe("Mar 5, 2024");
  });

  it("names today and yesterday", () => {
    rs.useFakeTimers().setSystemTime(new Date(2026, 5, 10, 9, 0, 0));
    expect(dayLabel(t, startOfDay(localNoon(2026, 6, 10)), "en")).toBe("timeline.today");
    expect(dayLabel(t, startOfDay(localNoon(2026, 6, 9)), "en")).toBe("timeline.yesterday");
  });

  it("still says yesterday across a daylight-saving change", () => {
    // US DST ends 2026-11-01, so 2026-11-01 local is 25 hours long: the day
    // before 11-02 is not "now minus 86,400 seconds".
    rs.useFakeTimers().setSystemTime(new Date(2026, 10, 2, 9, 0, 0));
    expect(dayLabel(t, startOfDay(localNoon(2026, 11, 1)), "en")).toBe("timeline.yesterday");
  });

  it("falls back to a date for anything older", () => {
    rs.useFakeTimers().setSystemTime(new Date(2026, 5, 10, 9, 0, 0));
    expect(dayLabel(t, startOfDay(localNoon(2026, 6, 8)), "en")).not.toBe("timeline.yesterday");
  });
});
