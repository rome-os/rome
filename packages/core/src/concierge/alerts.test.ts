import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  type AlertBatch,
  AlertCoalescer,
  type AlertEvent,
  BATCH_DELAY_MS,
  HOUR_MS,
  MAX_EVENTS_PER_BATCH,
  MIN_SPACING_MS,
  parseQuietHours,
  quietWindowEnd,
} from "./alerts.js";

const START = new Date("2026-11-03T12:00:00.000Z").getTime();

const event = (id: string): AlertEvent => ({
  id,
  source: "github",
  kind: "review_requested",
  fields: { repo: "acme/widgets" },
});

function setup(options: { quietUntil?: (at: number) => number | null; enabled?: boolean } = {}) {
  const batches: (AlertBatch & { deliveredAt: number })[] = [];
  const coalescer = new AlertCoalescer({
    now: () => Date.now(),
    isEnabled: async () => options.enabled ?? true,
    quietUntil: async (at) => options.quietUntil?.(at) ?? null,
    deliver: async (batch) => {
      batches.push({ ...batch, deliveredAt: Date.now() });
    },
  });
  return { coalescer, batches };
}

const ids = (batch: AlertBatch) => batch.events.map((e) => e.id);

describe("AlertCoalescer", () => {
  beforeEach(() => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date(START));
  });
  afterEach(() => {
    rs.useRealTimers();
  });

  it("batches a burst into one delivery a minute after its first event", async () => {
    const s = setup();
    s.coalescer.add(event("a"));
    await rs.advanceTimersByTimeAsync(20_000);
    s.coalescer.add(event("b"));
    await rs.advanceTimersByTimeAsync(BATCH_DELAY_MS - 20_000 - 1);
    expect(s.batches).toEqual([]);
    await rs.advanceTimersByTimeAsync(1);
    expect(s.batches.map(ids)).toEqual([["a", "b"]]);
    expect(s.batches[0]?.held).toBe(false);
  });

  it("drops a redelivered event", async () => {
    const s = setup();
    expect(s.coalescer.add(event("a"))).toBe(true);
    expect(s.coalescer.add(event("a"))).toBe(false);
    await rs.advanceTimersByTimeAsync(BATCH_DELAY_MS);
    expect(s.batches.map(ids)).toEqual([["a"]]);
  });

  it("caps a batch and counts the rest", async () => {
    const s = setup();
    for (let i = 0; i < MAX_EVENTS_PER_BATCH + 3; i++) s.coalescer.add(event(`e${i}`));
    await rs.advanceTimersByTimeAsync(BATCH_DELAY_MS);
    expect(s.batches[0]?.events).toHaveLength(MAX_EVENTS_PER_BATCH);
    expect(s.batches[0]?.omitted).toBe(3);
  });

  it("keeps 15 minutes between alert turns", async () => {
    const s = setup();
    s.coalescer.add(event("a"));
    await rs.advanceTimersByTimeAsync(BATCH_DELAY_MS);
    s.coalescer.add(event("b"));
    await rs.advanceTimersByTimeAsync(MIN_SPACING_MS - 1);
    expect(s.batches).toHaveLength(1);
    await rs.advanceTimersByTimeAsync(1);
    expect(s.batches.map(ids)).toEqual([["a"], ["b"]]);
    expect(s.batches[1]!.deliveredAt - s.batches[0]!.deliveredAt).toBe(MIN_SPACING_MS);
  });

  it("holds a third turn within the hour until the first is an hour old", async () => {
    const s = setup();
    const firstAt = START + BATCH_DELAY_MS;
    for (const id of ["a", "b", "c"]) {
      s.coalescer.add(event(id));
      await rs.advanceTimersByTimeAsync(MIN_SPACING_MS);
    }
    // Two turns, 15 minutes apart; the third waits for the hour to roll.
    expect(s.batches.map(ids)).toEqual([["a"], ["b"]]);
    await rs.advanceTimersByTimeAsync(firstAt + HOUR_MS - Date.now() - 1);
    expect(s.batches).toHaveLength(2);
    await rs.advanceTimersByTimeAsync(1);
    expect(s.batches.map(ids)).toEqual([["a"], ["b"], ["c"]]);
    expect(s.batches[2]!.deliveredAt).toBe(firstAt + HOUR_MS);
  });

  it("holds events through quiet hours and delivers them as one held batch", async () => {
    const quietEnd = START + 3 * HOUR_MS;
    const s = setup({ quietUntil: (at) => (at < quietEnd ? quietEnd : null) });
    s.coalescer.add(event("a"));
    await rs.advanceTimersByTimeAsync(HOUR_MS);
    s.coalescer.add(event("b"));
    await rs.advanceTimersByTimeAsync(quietEnd - Date.now() - 1);
    expect(s.batches).toEqual([]);
    await rs.advanceTimersByTimeAsync(1);
    expect(s.batches.map(ids)).toEqual([["a", "b"]]);
    expect(s.batches[0]?.held).toBe(true);
    // The next batch is an ordinary one again.
    s.coalescer.add(event("c"));
    await rs.advanceTimersByTimeAsync(MIN_SPACING_MS);
    expect(s.batches[1]?.held).toBe(false);
  });

  it("drops what waits when the Concierge is off", async () => {
    const s = setup({ enabled: false });
    s.coalescer.add(event("a"));
    await rs.advanceTimersByTimeAsync(BATCH_DELAY_MS);
    expect(s.batches).toEqual([]);
    expect(s.coalescer.pending).toBe(0);
  });
});

describe("quiet hours", () => {
  const at = (iso: string) => new Date(iso).getTime();

  it("finds the end of a window that wraps midnight, in the guardian's zone", () => {
    const quiet = { start: "22:00", end: "08:00" };
    // 23:30 in Shanghai is 15:30 UTC; the window ends at 08:00 Shanghai, 00:00 UTC.
    expect(quietWindowEnd(at("2026-11-03T15:30:00Z"), quiet, "Asia/Shanghai")).toBe(
      at("2026-11-04T00:00:00Z"),
    );
    // 07:59 Shanghai is still quiet.
    expect(quietWindowEnd(at("2026-11-03T23:59:00Z"), quiet, "Asia/Shanghai")).toBe(
      at("2026-11-04T00:00:00Z"),
    );
    // 12:00 Shanghai is not.
    expect(quietWindowEnd(at("2026-11-03T04:00:00Z"), quiet, "Asia/Shanghai")).toBeNull();
  });

  it("finds the end of a window within one day", () => {
    const quiet = { start: "12:00", end: "13:30" };
    expect(quietWindowEnd(at("2026-11-03T12:10:20Z"), quiet, "UTC")).toBe(
      at("2026-11-03T13:30:00Z"),
    );
    expect(quietWindowEnd(at("2026-11-03T13:30:00Z"), quiet, "UTC")).toBeNull();
  });

  it("parses only two different HH:mm times", () => {
    expect(parseQuietHours({ start: "22:00", end: "08:00" })).toEqual({
      start: "22:00",
      end: "08:00",
    });
    expect(parseQuietHours({ start: "22:00", end: "22:00" })).toBeNull();
    expect(parseQuietHours({ start: "9:00", end: "18:00" })).toBeNull();
    expect(parseQuietHours(null)).toBeNull();
  });
});
