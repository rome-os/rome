import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  formatTimestamp,
  Timestamp,
  TimestampProvider,
  useTimestampSettings,
} from "./timestamp.js";

afterEach(() => {
  cleanup();
  rs.useRealTimers();
});

// ICU joins a clock and its day period with U+202F in newer releases and a
// plain space in older ones; the assertions care about the words, not the gap.
function plain(text: string | null): string | null {
  return text === null ? null : text.replace(/[  ]/g, " ");
}

// 15:04:05 UTC — 00:04 the next day in Tokyo, 11:04 the same morning in New York.
const INSTANT = "2026-09-03T15:04:05.000Z";
const EN = "en-US";

function relative(value: string | number, now: string, timeZone = "UTC"): string | null {
  return plain(
    formatTimestamp(value, { format: "relative", timeZone, locale: EN, now: Date.parse(now) }),
  );
}

describe("formatTimestamp", () => {
  it("renders each preset in the given zone", () => {
    const tokyo = (format: "time" | "date" | "datetime" | "full") =>
      plain(formatTimestamp(INSTANT, { format, timeZone: "Asia/Tokyo", locale: EN }));

    expect(tokyo("time")).toBe("12:04 AM");
    expect(tokyo("date")).toBe("Sep 4, 2026");
    expect(tokyo("datetime")).toBe("Sep 4, 2026, 12:04 AM");
    expect(tokyo("full")).toBe("Friday, September 4, 2026 at 12:04 AM GMT+9");
  });

  it("moves the calendar day with the zone", () => {
    const newYork = plain(
      formatTimestamp(INSTANT, { format: "datetime", timeZone: "America/New_York", locale: EN }),
    );
    expect(newYork).toBe("Sep 3, 2026, 11:04 AM");
  });

  it("takes raw Intl options for a layout the presets lack", () => {
    const text = plain(
      formatTimestamp(INSTANT, {
        format: { weekday: "short", hour: "numeric" },
        timeZone: "UTC",
        locale: EN,
      }),
    );
    expect(text).toBe("Thu, 3 PM");
  });

  it("accepts a Date, an ISO string, and epoch milliseconds alike", () => {
    const options = { format: "date" as const, timeZone: "UTC", locale: EN };
    const fromString = formatTimestamp(INSTANT, options);

    expect(formatTimestamp(new Date(INSTANT), options)).toBe(fromString);
    expect(formatTimestamp(Date.parse(INSTANT), options)).toBe(fromString);
  });

  it("returns null for nothing or for text that is not a date", () => {
    expect(formatTimestamp(null)).toBeNull();
    expect(formatTimestamp(undefined)).toBeNull();
    expect(formatTimestamp("last tuesday")).toBeNull();
  });

  it("falls back to the runtime zone when the zone does not resolve", () => {
    const runtimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const expected = formatTimestamp(INSTANT, { format: "full", timeZone: runtimeZone });

    expect(formatTimestamp(INSTANT, { format: "full", timeZone: "Mars/Olympus_Mons" })).toBe(
      expected,
    );
  });

  describe("relative", () => {
    const NOW = "2026-09-03T12:00:00.000Z";

    it("reads as now inside a minute either side", () => {
      expect(relative("2026-09-03T11:59:30.000Z", NOW)).toBe("now");
      expect(relative("2026-09-03T12:00:30.000Z", NOW)).toBe("now");
    });

    it("counts minutes, then hours, rounding to the nearest unit", () => {
      expect(relative("2026-09-03T11:55:00.000Z", NOW)).toBe("5 minutes ago");
      expect(relative("2026-09-03T10:31:00.000Z", NOW)).toBe("1 hour ago");
      expect(relative("2026-09-03T10:30:00.000Z", NOW)).toBe("2 hours ago");
      expect(relative("2026-09-02T13:00:00.000Z", NOW)).toBe("23 hours ago");
      expect(relative("2026-09-03T14:00:00.000Z", NOW)).toBe("in 2 hours");
    });

    it("switches to calendar days in the zone once a day has passed", () => {
      // 25.5 hours before 01:00 UTC on the 3rd is 23:30 UTC on the 1st — two
      // dates back in UTC, but 08:30 on the 2nd in Tokyo, one date back.
      const now = "2026-09-03T01:00:00.000Z";
      const value = "2026-09-01T23:30:00.000Z";

      expect(relative(value, now, "UTC")).toBe("2 days ago");
      expect(relative(value, now, "Asia/Tokyo")).toBe("yesterday");
    });

    it("names tomorrow by date too", () => {
      expect(relative("2026-09-04T18:00:00.000Z", NOW)).toBe("tomorrow");
    });

    it("climbs through weeks, months, and years", () => {
      expect(relative("2026-08-24T12:00:00.000Z", NOW)).toBe("last week");
      expect(relative("2026-08-14T12:00:00.000Z", NOW)).toBe("3 weeks ago");
      expect(relative("2026-07-20T12:00:00.000Z", NOW)).toBe("last month");
      expect(relative("2026-03-03T12:00:00.000Z", NOW)).toBe("6 months ago");
      expect(relative("2025-07-30T12:00:00.000Z", NOW)).toBe("last year");
      expect(relative("2028-09-10T12:00:00.000Z", NOW)).toBe("in 2 years");
    });
  });
});

describe("Timestamp", () => {
  it("renders a <time> carrying the ISO instant and the full rendering as its title", () => {
    render(<Timestamp value={INSTANT} format="date" timeZone="Asia/Tokyo" locale={EN} />);
    const time = screen.getByText("Sep 4, 2026");

    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("datetime")).toBe(INSTANT);
    expect(plain(time.getAttribute("title"))).toBe("Friday, September 4, 2026 at 12:04 AM GMT+9");
  });

  it("carries no title in the full layout, and the caller's title elsewhere", () => {
    render(
      <>
        <Timestamp value={INSTANT} format="full" timeZone="UTC" locale={EN} />
        <Timestamp value={INSTANT} format="time" timeZone="UTC" locale={EN} title="sent" />
      </>,
    );

    expect(screen.getByText(/September 3, 2026/).hasAttribute("title")).toBe(false);
    expect(screen.getByTitle("sent").textContent?.replace(/[  ]/g, " ")).toBe("3:04 PM");
  });

  it("renders the fallback, with no dateTime, when the value is empty or not a date", () => {
    render(
      <>
        <Timestamp value={null} data-testid="empty" />
        <Timestamp value="soon" fallback="unknown" data-testid="bad" />
      </>,
    );

    expect(screen.getByTestId("empty").textContent).toBe("—");
    expect(screen.getByTestId("empty").hasAttribute("datetime")).toBe(false);
    expect(screen.getByTestId("bad").textContent).toBe("unknown");
  });

  it("takes the zone from the provider, and a prop over the provider", () => {
    render(
      <TimestampProvider timeZone="Asia/Tokyo" locale={EN}>
        <Timestamp value={INSTANT} format="date" data-testid="provided" />
        <Timestamp value={INSTANT} format="date" timeZone="America/New_York" data-testid="own" />
      </TimestampProvider>,
    );

    expect(screen.getByTestId("provided").textContent).toBe("Sep 4, 2026");
    expect(screen.getByTestId("own").textContent).toBe("Sep 3, 2026");
  });

  it("forwards the ref to the <time> in both branches", () => {
    const dated = createRef<HTMLTimeElement>();
    const empty = createRef<HTMLTimeElement>();
    render(
      <>
        <Timestamp ref={dated} value={INSTANT} format="date" />
        <Timestamp ref={empty} value={null} />
      </>,
    );

    expect(dated.current?.tagName).toBe("TIME");
    expect(empty.current?.tagName).toBe("TIME");
  });

  it("re-renders a relative label on its own as the clock moves", () => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    render(<Timestamp value="2026-09-03T11:59:30.000Z" timeZone="UTC" locale={EN} />);
    const time = screen.getByRole("time");

    expect(time.textContent).toBe("now");

    // 30 seconds on, the entry is a minute old — and nothing fires before that.
    act(() => rs.advanceTimersByTime(29_000));
    expect(time.textContent).toBe("now");
    act(() => rs.advanceTimersByTime(1_000));
    expect(time.textContent).toBe("1 minute ago");

    // The next flip is at the rounding point, 90 seconds old.
    act(() => rs.advanceTimersByTime(29_000));
    expect(time.textContent).toBe("1 minute ago");
    act(() => rs.advanceTimersByTime(1_000));
    expect(time.textContent).toBe("2 minutes ago");
  });

  it("flips a calendar-day label at local midnight in the zone", () => {
    rs.useFakeTimers();
    // 23:30 in Tokyo on the 3rd; the entry is from the morning of the 2nd.
    rs.setSystemTime(new Date("2026-09-03T14:30:00.000Z"));
    render(<Timestamp value="2026-09-02T00:00:00.000Z" timeZone="Asia/Tokyo" locale={EN} />);
    const time = screen.getByRole("time");

    expect(time.textContent).toBe("yesterday");
    act(() => rs.advanceTimersByTime(30 * 60_000 - 1));
    expect(time.textContent).toBe("yesterday");
    act(() => rs.advanceTimersByTime(1));
    expect(time.textContent).toBe("2 days ago");
  });

  it("stops ticking once unmounted", () => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { unmount } = render(<Timestamp value="2026-09-03T11:59:30.000Z" timeZone="UTC" />);

    expect(rs.getTimerCount()).toBe(1);
    unmount();
    expect(rs.getTimerCount()).toBe(0);
  });

  it("holds no timer for an absolute layout", () => {
    rs.useFakeTimers();
    render(<Timestamp value={INSTANT} format="datetime" timeZone="UTC" />);

    expect(rs.getTimerCount()).toBe(0);
  });
});

describe("useTimestampSettings", () => {
  it("returns the provider's zone, and the runtime's without one", () => {
    const provided = renderHook(() => useTimestampSettings(), {
      wrapper: ({ children }) => (
        <TimestampProvider timeZone="Asia/Tokyo" locale={EN}>
          {children}
        </TimestampProvider>
      ),
    });
    const bare = renderHook(() => useTimestampSettings());

    expect(provided.result.current).toEqual({ timeZone: "Asia/Tokyo", locale: EN });
    expect(bare.result.current.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(bare.result.current.locale).toBeUndefined();
  });
});
