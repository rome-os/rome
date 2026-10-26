// @rstest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { useNow } from "./use-now";

afterEach(() => {
  cleanup();
  rs.useRealTimers();
});

describe("useNow", () => {
  it("ticks each second while active and stops when not", () => {
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { result, rerender } = renderHook(({ active }) => useNow(active), {
      initialProps: { active: true },
    });
    const start = result.current;
    act(() => {
      rs.advanceTimersByTime(3000);
    });
    expect(result.current - start).toBe(3000);

    rerender({ active: false });
    const stopped = result.current;
    act(() => {
      rs.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(stopped);
  });
});
