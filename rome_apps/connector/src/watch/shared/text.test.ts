import { describe, expect, it } from "@rstest/core";
import { cleanText, EXCERPT_CHARS, excerptOf, subjectOf } from "./text.js";

const c = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const CGJ = c(0x034f); // combining grapheme joiner
const ZWSP = c(0x200b); // zero-width space
const ZWNJ = c(0x200c);
const ZWJ = c(0x200d);
const SHY = c(0x00ad); // soft hyphen
const BOM = c(0xfeff);
const NBSP = c(0x00a0);

describe("cleanText", () => {
  it("drops the padding a marketing preview hides, as seen in a real mail", () => {
    // A preview padded with runs of combining grapheme joiners and spaces after its visible text, as newsletters do.
    const preview = `Your weekly digest is here ${`${CGJ} `.repeat(40)}${ZWNJ}${NBSP}`;
    expect(cleanText(preview)).toBe("Your weekly digest is here");
  });

  it("drops zero-width characters, soft hyphens and the BOM, and collapses spaces", () => {
    expect(cleanText(`${BOM}Con${SHY}tract re${ZWSP}view${ZWJ}  needed\n\n by\t tomorrow `)).toBe(
      "Contract review needed by tomorrow",
    );
  });
});

describe("subjectOf and excerptOf", () => {
  it("leave nothing when only invisible characters were there", () => {
    expect(subjectOf(`${CGJ} ${ZWSP}${NBSP}`)).toBeUndefined();
    expect(excerptOf(`${CGJ}${CGJ}`)).toBeUndefined();
    expect(subjectOf(undefined)).toBeUndefined();
  });

  it("cut an excerpt after cleaning, so padding never takes the room", () => {
    const body = `${`${CGJ} `.repeat(300)}${"x".repeat(EXCERPT_CHARS + 50)}`;
    const excerpt = excerptOf(body)!;
    expect(excerpt.startsWith("x")).toBe(true);
    expect(excerpt.length).toBe(EXCERPT_CHARS + 1);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});
