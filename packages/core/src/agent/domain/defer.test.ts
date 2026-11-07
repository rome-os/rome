import { describe, expect, it } from "@rstest/core";
import { parseDeferInput } from "./defer.js";

// A fixed "now" on a minute boundary keeps the ceil math easy to reason about.
const NOW = Date.parse("2026-06-25T12:00:00.000Z");

describe("parseDeferInput", () => {
  it("requires a non-empty name", () => {
    expect(parseDeferInput({ afterMinutes: 5 }, NOW).ok).toBe(false);
    // whitespace-only is trimmed to empty and rejected
    expect(parseDeferInput({ name: "   ", afterMinutes: 5 }, NOW).ok).toBe(false);
  });

  it("trims the name", () => {
    const r = parseDeferInput({ name: "  check CI  ", afterMinutes: 5 }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe("check CI");
  });

  it("requires exactly one of afterMinutes/at", () => {
    expect(parseDeferInput({ name: "x" }, NOW).ok).toBe(false);
    expect(
      parseDeferInput({ name: "x", afterMinutes: 5, at: "2026-06-25T13:00:00Z" }, NOW).ok,
    ).toBe(false);
  });

  it("rejects a non-positive or non-integer afterMinutes", () => {
    expect(parseDeferInput({ name: "x", afterMinutes: 0 }, NOW).ok).toBe(false);
    expect(parseDeferInput({ name: "x", afterMinutes: -5 }, NOW).ok).toBe(false);
    expect(parseDeferInput({ name: "x", afterMinutes: 1.5 }, NOW).ok).toBe(false);
  });

  it("resolves afterMinutes to an absolute minute-aligned instant", () => {
    const r = parseDeferInput({ name: "check CI", afterMinutes: 5 }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "time") {
      expect(r.name).toBe("check CI");
      expect(new Date(r.fireAtMs).toISOString()).toBe("2026-06-25T12:05:00.000Z");
    }
  });

  it("ceils to the next whole minute when now is mid-minute (never the past)", () => {
    // now at :30s, afterMinutes 1 -> raw 12:01:30 -> ceil -> 12:02:00.
    const now = Date.parse("2026-06-25T12:00:30.000Z");
    const r = parseDeferInput({ name: "x", afterMinutes: 1 }, now);
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "time")
      expect(new Date(r.fireAtMs).toISOString()).toBe("2026-06-25T12:02:00.000Z");
  });

  it("accepts an absolute ISO instant", () => {
    const r = parseDeferInput({ name: "x", at: "2026-06-25T18:30:00Z" }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "time")
      expect(new Date(r.fireAtMs).toISOString()).toBe("2026-06-25T18:30:00.000Z");
  });

  it("rejects an at-instant in the past", () => {
    expect(parseDeferInput({ name: "x", at: "2020-01-01T00:00:00Z" }, NOW).ok).toBe(false);
  });

  it("rejects an unparseable at-instant", () => {
    expect(parseDeferInput({ name: "x", at: "tomorrow" }, NOW).ok).toBe(false);
  });
});

describe("parseDeferInput with an event", () => {
  it("trims the event's match strings", () => {
    const r = parseDeferInput(
      {
        name: "CI",
        event: {
          eventName: "  ci.done ",
          sourcePattern: " connector ",
          filter: [{ field: " pr.number ", equals: " 12" }],
        },
      },
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "event") {
      expect(r.event).toEqual({
        eventName: "ci.done",
        sourcePattern: "connector",
        // `equals` is matched against payload values verbatim, so it isn't trimmed.
        filter: [{ field: "pr.number", equals: " 12" }],
      });
    }
  });

  it("requires exactly one of afterMinutes/at/event", () => {
    expect(
      parseDeferInput({ name: "x", afterMinutes: 5, event: { eventName: "ci.done" } }, NOW).ok,
    ).toBe(false);
    expect(
      parseDeferInput({ name: "x", at: "2026-06-25T13:00:00Z", event: { eventName: "e" } }, NOW).ok,
    ).toBe(false);
  });

  // In a live run a model nested a field one level off, and zod's default
  // stripping dropped it without a word. An unknown key at either level is an
  // error naming where it sits.
  it("rejects an unknown key instead of silently dropping it", () => {
    const top = parseDeferInput({ name: "x", event: { eventName: "e" }, note: "y" }, NOW);
    expect(top).toMatchObject({ ok: false });
    if (!top.ok) expect(top.error).toMatch(/^defer: .*note/);

    const nested = parseDeferInput({ name: "x", event: { eventName: "e", source: "ci" } }, NOW);
    expect(nested).toMatchObject({ ok: false });
    if (!nested.ok) expect(nested.error).toMatch(/^defer\.event: .*source/);
  });

  it("rejects a blank eventName, a blank sourcePattern, or a filter path with an empty segment", () => {
    expect(parseDeferInput({ name: "x", event: { eventName: "  " } }, NOW).ok).toBe(false);
    expect(
      parseDeferInput({ name: "x", event: { eventName: "e", sourcePattern: " " } }, NOW).ok,
    ).toBe(false);
    expect(
      parseDeferInput(
        { name: "x", event: { eventName: "e", filter: [{ field: "a..b", equals: "1" }] } },
        NOW,
      ).ok,
    ).toBe(false);
  });
});
