import { describe, expect, it } from "@rstest/core";
import {
  isSessionTraceArchived,
  sessionTraceCutoff,
  TRACE_RETENTION_MS,
} from "./trace-retention.js";

describe("session trace retention", () => {
  it("archives at exactly seven idle days, not before", () => {
    const now = new Date("2026-10-24T12:00:00Z");
    const cutoff = sessionTraceCutoff(now);
    expect(now.getTime() - cutoff.getTime()).toBe(TRACE_RETENTION_MS);
    expect(isSessionTraceArchived(new Date(cutoff.getTime() + 1), cutoff)).toBe(false);
    expect(isSessionTraceArchived(cutoff, cutoff)).toBe(true);
    expect(isSessionTraceArchived(new Date(cutoff.getTime() - 1), cutoff)).toBe(true);
  });
});
