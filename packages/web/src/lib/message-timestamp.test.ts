import { describe, expect, it } from "@rstest/core";
import { formatMessageTimestamp } from "./message-timestamp";

// The reference "now": July 10, 2026, 20:00 local time.
const NOW = new Date(2026, 6, 10, 20, 0, 0);

describe("formatMessageTimestamp", () => {
  it("shows only the time of day for a message sent today", () => {
    const sameDay = new Date(2026, 6, 10, 18, 41).toISOString();
    const out = formatMessageTimestamp(sameDay, NOW);
    // Locale-dependent rendering (e.g. "6:41 PM" / "18:41"), but never a date part.
    expect(out).toContain("41");
    expect(out).not.toMatch(/jul|10|2026/i);
  });

  it("shows month + day (no year, no time) for a message earlier this year", () => {
    const thisYear = new Date(2026, 2, 5, 9, 30).toISOString();
    const out = formatMessageTimestamp(thisYear, NOW);
    expect(out).toMatch(/mar/i);
    expect(out).toContain("5");
    expect(out).not.toContain("2026");
    expect(out).not.toContain(":");
  });

  it("shows month + day + year for a message from a previous year", () => {
    const lastYear = new Date(2025, 11, 29, 14, 0).toISOString();
    const out = formatMessageTimestamp(lastYear, NOW);
    expect(out).toMatch(/dec/i);
    expect(out).toContain("29");
    expect(out).toContain("2025");
    expect(out).not.toContain(":");
  });

  it("treats yesterday as a date, not a time, even within 24 hours", () => {
    const yesterdayEvening = new Date(2026, 6, 9, 23, 59).toISOString();
    const out = formatMessageTimestamp(yesterdayEvening, NOW);
    expect(out).toMatch(/jul/i);
    expect(out).toContain("9");
  });

  it("returns an empty string for an unparseable value", () => {
    expect(formatMessageTimestamp("not-a-date", NOW)).toBe("");
  });
});
