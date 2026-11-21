import { describe, expect, it } from "@rstest/core";
import { DEFAULT_SPLIT_LIMITS, splitForStreams } from "./split-text.js";

describe("splitForStreams", () => {
  it("returns text that fits whole, trimmed", () => {
    expect(splitForStreams("  你好，世界。 ")).toEqual(["你好，世界。"]);
    expect(splitForStreams("   ")).toEqual([]);
  });

  it("keeps every part within the character limit and loses no text", () => {
    const text = "word ".repeat(3000).trim(); // 14,999 characters
    const parts = splitForStreams(text);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(5000);
    expect(parts.join(" ")).toBe(text);
  });

  it("keeps Chinese parts within the audio limit, which is far under 5000 characters", () => {
    const sentence = "这是一个很长的句子，用来试试按时长切开。";
    const text = sentence.repeat(60); // 1,200 characters, about 5 minutes spoken
    const parts = splitForStreams(text);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const part of parts) expect(part.length * 0.28).toBeLessThanOrEqual(100);
    expect(parts.join("")).toBe(text);
  });

  it("breaks at the end of a sentence in preference to the middle of one", () => {
    const parts = splitForStreams("甲乙丙丁。戊己庚辛壬。", { maxChars: 8, maxSeconds: 100 });
    expect(parts).toEqual(["甲乙丙丁。", "戊己庚辛壬。"]);
  });

  it("falls back to a comma, then a space, then the limit", () => {
    expect(splitForStreams("甲乙丙，丁戊己庚辛", { maxChars: 6, maxSeconds: 100 })).toEqual([
      "甲乙丙，",
      "丁戊己庚辛",
    ]);
    expect(splitForStreams("aaa bbb ccc", { maxChars: 8, maxSeconds: 100 })).toEqual([
      "aaa bbb",
      "ccc",
    ]);
    expect(splitForStreams("abcdefghij", { maxChars: 4, maxSeconds: 100 })).toEqual([
      "abcd",
      "efgh",
      "ij",
    ]);
  });

  it("ignores a break so early that it would leave a stub", () => {
    expect(splitForStreams("甲。乙丙丁戊己庚辛壬", { maxChars: 8, maxSeconds: 100 })).toEqual([
      "甲。乙丙丁戊己庚",
      "辛壬",
    ]);
  });

  it("never splits a character made of two UTF-16 units", () => {
    const parts = splitForStreams("😀".repeat(10), { maxChars: 6, maxSeconds: 100 });
    expect(parts.join("")).toBe("😀".repeat(10));
    for (const part of parts) expect([...part].every((c) => c === "😀")).toBe(true);
  });

  it("uses limits under the provider's: 5000 characters and under 120 s", () => {
    expect(DEFAULT_SPLIT_LIMITS).toEqual({ maxChars: 5000, maxSeconds: 100 });
  });
});
