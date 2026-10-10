import { describe, expect, it } from "@rstest/core";
import { lastBreak, splitPoint, splitsPair } from "./split.js";
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

describe("splitPoint, where a full stop may be part of a number or a name", () => {
  it("does not end a part between a decimal point and its digits", () => {
    // A cut at "ab 3." would leave "14" for the next message.
    expect(splitPoint("ab 3.14", 5, plainText)).toBe(3);
  });

  it("still ends a part after a full stop that whitespace follows", () => {
    expect(splitPoint("ab 3. 14", 5, plainText)).toBe(5);
  });
});

describe("lastBreak", () => {
  it("ends after the last whitespace when a full stop ends the text that has arrived", () => {
    // The text may go on as "3.14", so the full stop is not a sentence end yet.
    expect(lastBreak("The value of pi is 3.")).toBe("The value of pi is ".length);
  });

  it("has no break inside a name, a number or a word", () => {
    expect(lastBreak("example.com")).toBe(0);
    expect(lastBreak("v1.2")).toBe(0);
    expect(lastBreak("Hello")).toBe(0);
  });

  it("treats a full stop followed by whitespace as a sentence end", () => {
    expect(lastBreak("Done. Next")).toBe("Done.".length);
  });

  it("prefers a paragraph break in the second half to a later space", () => {
    const text = "First paragraph here.\n\nSecond one";
    expect(lastBreak(text)).toBe("First paragraph here.\n\n".length);
  });

  it("ends after a full-width full stop at once, since nothing follows one in Chinese", () => {
    expect(lastBreak("第一句话说完了。")).toBe("第一句话说完了。".length);
  });
});

describe("splitsPair", () => {
  it("is true only between the two halves of a surrogate pair", () => {
    const text = "a😀b";
    expect(splitsPair(text, 1)).toBe(false);
    expect(splitsPair(text, 2)).toBe(true);
    expect(splitsPair(text, 3)).toBe(false);
  });

  it("is false at either end of the text", () => {
    expect(splitsPair("😀", 0)).toBe(false);
    expect(splitsPair("😀", 2)).toBe(false);
    expect(splitsPair("", 0)).toBe(false);
  });
});
