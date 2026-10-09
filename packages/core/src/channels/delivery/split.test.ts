import { describe, expect, it } from "@rstest/core";
import { splitPoint } from "./split.js";
import { plainText, type TextCodec } from "./types.js";

describe("splitPoint", () => {
  it("keeps text that fits whole", () => {
    expect(splitPoint("hello world", 20, plainText)).toBe(11);
  });

  it("ends at the best readable break in the second half", () => {
    const text = "First paragraph here.\n\nSecond one, which runs on and on";
    expect(splitPoint(text, 30, plainText)).toBe("First paragraph here.\n\n".length);
  });

  it("prefers a sentence end to a space", () => {
    expect(splitPoint("One two three. Four five six seven", 20, plainText)).toBe(
      "One two three.".length,
    );
  });

  it("breaks Chinese text after its full stop", () => {
    expect(splitPoint("第一句话说完了。第二句话还在继续说下去", 12, plainText)).toBe(8);
  });

  it("cuts at the limit when no break lies in the second half", () => {
    expect(splitPoint("a".repeat(50), 20, plainText)).toBe(20);
  });

  it("never splits a surrogate pair", () => {
    const text = `${"a".repeat(9)}😀${"b".repeat(10)}`;
    const end = splitPoint(text, 10, plainText);
    expect(end).toBe(9);
    expect(text.slice(end).codePointAt(0)).toBe(0x1f600);
  });

  it("fits what the codec renders, preview and settled", () => {
    // A preview closes an open fence, which costs four characters.
    const fenced: TextCodec = {
      render: (source, settled) => (settled ? source : `${source}\n\`\`\``),
      measure: (rendered) => rendered.length,
    };
    expect(splitPoint("x".repeat(30), 20, fenced)).toBe(16);
  });

  it("renders a logarithmic number of prefixes", () => {
    let renders = 0;
    const counting: TextCodec = {
      render: (source) => {
        renders += 1;
        return source;
      },
      measure: (rendered) => rendered.length,
    };
    splitPoint("a".repeat(100_000), 4096, counting);
    expect(renders).toBeLessThan(2 * 2 * Math.ceil(Math.log2(100_000)) + 4);
  });

  it("refuses a limit no character fits", () => {
    expect(() => splitPoint("abc", 0, plainText)).toThrow("Not even one character fits");
  });
});
