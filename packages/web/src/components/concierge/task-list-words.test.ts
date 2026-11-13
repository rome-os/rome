import { describe, expect, it } from "@rstest/core";
import { describeRoutineTrigger, describeTaskSchedule, formatClock } from "./task-list-words";

/** Says the key and its options, so a test reads what was chosen. */
const t = (key: string, options?: Record<string, unknown>) =>
  `${key.replace("concierge.taskList.schedule.", "")}${options ? ` ${JSON.stringify(options)}` : ""}`;

describe("formatClock", () => {
  it("writes a stored time of day as the locale does", () => {
    expect(formatClock("21:30", "en-US")).toBe("9:30 PM");
    expect(formatClock("08:00", "en-GB")).toBe("8:00");
  });
});

describe("describeTaskSchedule", () => {
  it("says daily for every day, and names the weekdays otherwise, in week order", () => {
    expect(describeTaskSchedule({ at: "08:00", days: null }, t, "en-GB")).toBe(
      'daily {"time":"8:00"}',
    );
    expect(describeTaskSchedule({ at: "08:00", days: ["wed", "mon"] }, t, "en-GB")).toBe(
      'days {"days":"Mon, Wed","time":"8:00"}',
    );
  });
});

describe("describeRoutineTrigger", () => {
  const schedule = (rrule: string | null, date: string | null = null) =>
    ({ type: "schedule", localTime: "09:00", rrule, date }) as const;

  it("reads daily and weekly rules, a one-off, an event and a manual routine", () => {
    expect(describeRoutineTrigger(schedule("FREQ=DAILY"), t, "en-GB")).toBe(
      'daily {"time":"9:00"}',
    );
    expect(describeRoutineTrigger(schedule("FREQ=WEEKLY;BYDAY=MO,FR"), t, "en-GB")).toBe(
      'days {"days":"Mon, Fri","time":"9:00"}',
    );
    expect(describeRoutineTrigger(schedule(null, "2026-12-01"), t, "en-GB")).toBe(
      'once {"date":"1 Dec","time":"9:00"}',
    );
    expect(describeRoutineTrigger({ type: "event-bus", eventName: "mail.new" }, t, "en")).toBe(
      'event {"event":"mail.new"}',
    );
    expect(describeRoutineTrigger({ type: "manual" }, t, "en")).toBe("manual");
  });

  it("names the zone of a fixed-zone time unlike the browser's, as the Routines page does", () => {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const other = browser === "Pacific/Auckland" ? "America/Los_Angeles" : "Pacific/Auckland";
    const zoned = (tzid: string, tzMode: "fixed" | "floating") =>
      ({ ...schedule("FREQ=DAILY"), tzid, tzMode }) as const;
    expect(describeRoutineTrigger(zoned(other, "fixed"), t, "en-GB")).toBe(
      `daily {"time":"9:00 (${other})"}`,
    );
    expect(describeRoutineTrigger(zoned(other, "floating"), t, "en-GB")).toBe(
      'daily {"time":"9:00"}',
    );
    expect(describeRoutineTrigger(zoned(browser, "fixed"), t, "en-GB")).toBe(
      'daily {"time":"9:00"}',
    );
  });

  it("says only that it runs on a schedule for a rule it does not read", () => {
    expect(describeRoutineTrigger(schedule("FREQ=HOURLY;INTERVAL=2"), t, "en")).toBe("other");
  });
});
