import { describe, expect, it } from "@rstest/core";
import { svgToPng } from "./rasterize.js";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">' +
  '<rect width="1200" height="630" fill="#f3c4bd"/>' +
  '<text x="96" y="300" font-family="sans-serif" font-size="64">Hello 你好</text></svg>';

describe("svgToPng", () => {
  it("renders a 1200x630 PNG", async () => {
    const png = await svgToPng(SVG);
    // PNG signature
    expect(Array.from(png.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    // IHDR width/height are big-endian u32 at offsets 16 and 20
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });
});
