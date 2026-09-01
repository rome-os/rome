import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { describeOutcome, describeSchedule, type ScheduleTrigger } from "./routine-language";

/** Pin the "browser" timezone that `tzDiffersFromBrowser` reads, without
 * disturbing the formatting `Intl.DateTimeFormat(locale, opts)` calls (which
 * pass arguments). Only the arg-less `Intl.DateTimeFormat()` is overridden. */
function mockBrowserTz(tz: string) {
  const Real = Intl.DateTimeFormat;
  rs.spyOn(Intl, "DateTimeFormat").mockImplementation(((...args: unknown[]) => {
    const inst = new (Real as unknown as new (...a: unknown[]) => Intl.DateTimeFormat)(...args);
    if (args.length === 0) {
      return {
        ...inst,
        resolvedOptions: () => ({ ...inst.resolvedOptions(), timeZone: tz }),
      } as unknown as Intl.DateTimeFormat;
    }
    return inst;
  }) as unknown as typeof Intl.DateTimeFormat);
}

const daily = (extra: Partial<ScheduleTrigger>): ScheduleTrigger => ({
  type: "schedule",
  tzid: "Asia/Tokyo",
  localTime: "09:00",
  rrule: "FREQ=DAILY",
  ...extra,
});

describe("describeSchedule timezone suffix", () => {
  afterEach(() => rs.restoreAllMocks());

  it("omits the tz suffix for a floating schedule even when tzid differs from the browser", () => {
    mockBrowserTz("UTC");
    const sentence = describeSchedule(daily({ tzMode: "floating" }));
    expect(sentence).toBe("Every day at 9:00 AM");
    expect(sentence).not.toContain("Asia/Tokyo");
  });

  it("treats an absent tzMode (draft/legacy) as floating — no suffix", () => {
    mockBrowserTz("UTC");
    expect(describeSchedule(daily({}))).toBe("Every day at 9:00 AM");
  });

  it("keeps the tz suffix for a fixed schedule pinned to a different zone", () => {
    mockBrowserTz("UTC");
    expect(describeSchedule(daily({ tzMode: "fixed" }))).toBe("Every day at 9:00 AM (Asia/Tokyo)");
  });

  it("omits the suffix for a fixed schedule already in the browser's zone", () => {
    mockBrowserTz("Asia/Tokyo");
    expect(describeSchedule(daily({ tzMode: "fixed" }))).toBe("Every day at 9:00 AM");
  });
});

describe("describeOutcome artifact ids", () => {
  it("humanizes only the local action name", () => {
    expect(describeOutcome("dream:review_skill", {})).toBe("review skill");
  });

  it("applies known action wording to canonical ids", () => {
    expect(describeOutcome("system:summon", {})).toBe("spin up an agent to help");
  });
});
