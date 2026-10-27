import { describe, expect, it } from "@rstest/core";
import { formatMessageTimestamp } from "./message-timestamp";

// The reference "now": July 10, 2026, 20:00 local time.
const NOW = new Date(2026, 6, 10, 20, 0, 0);

// Locale-dependent rendering ("6:41 PM" / "18:41"): the hour is 6 or 18, the minutes are 41.
const CLOCK_6_41_PM = /\b(6|18):41\b/;

describe("formatMessageTimestamp", () => {
  it("shows only the time of day for a message sent today", () => {
    const sameDay = new Date(2026, 6, 10, 18, 41).toISOString();
    const out = formatMessageTimestamp(sameDay, NOW);
    expect(out).toMatch(CLOCK_6_41_PM);
    expect(out).not.toMatch(/jul|10|2026/i);
  });

  it("shows month, day, and time for a message earlier this year", () => {
    const thisYear = new Date(2026, 2, 5, 18, 41).toISOString();
    const out = formatMessageTimestamp(thisYear, NOW);
    expect(out).toMatch(/mar/i);
    expect(out).toContain("5");
    expect(out).toMatch(CLOCK_6_41_PM);
    expect(out).not.toContain("2026");
  });

  it("shows month, day, year, and time for a message from a previous year", () => {
    const lastYear = new Date(2025, 11, 29, 18, 41).toISOString();
    const out = formatMessageTimestamp(lastYear, NOW);
    expect(out).toMatch(/dec/i);
    expect(out).toContain("29");
    expect(out).toContain("2025");
    expect(out).toMatch(CLOCK_6_41_PM);
  });

  it("treats yesterday as a date with a time, even within 24 hours", () => {
    const yesterdayEvening = new Date(2026, 6, 9, 23, 59).toISOString();
    const out = formatMessageTimestamp(yesterdayEvening, NOW);
    expect(out).toMatch(/jul/i);
    expect(out).toContain("9");
    expect(out).toMatch(/\b(11|23):59\b/);
  });

  it("keeps a zero-padded minute for an earlier day", () => {
    const out = formatMessageTimestamp(new Date(2026, 6, 9, 14, 5).toISOString(), NOW);
    expect(out).toMatch(/:05\b/);
  });

  it("returns an empty string for an unparseable value", () => {
    expect(formatMessageTimestamp("not-a-date", NOW)).toBe("");
  });
});
