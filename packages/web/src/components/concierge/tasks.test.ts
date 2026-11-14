import { describe, expect, it } from "@rstest/core";
import { formatTaskTime } from "./tasks";

const NOW = Date.UTC(2026, 9, 29, 12);
const DAY = 86_400_000;

describe("formatTaskTime", () => {
  it("reads a time in the reader's language", () => {
    expect(formatTaskTime(NOW - 5 * 60_000, NOW, "en")).toBe("5 min ago");
    expect(formatTaskTime(NOW - 3 * 3_600_000, NOW, "en")).toBe("3 hr ago");
    expect(formatTaskTime(NOW + DAY, NOW, "en")).toBe("tomorrow");
    // Short abbreviations come without their dots.
    expect(formatTaskTime(NOW + 25 * 60_000, NOW, "en")).toBe("in 25 min");
    expect(formatTaskTime(NOW - 10_000, NOW, "en")).toBe("now");
  });
});
