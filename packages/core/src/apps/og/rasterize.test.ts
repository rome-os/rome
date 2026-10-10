import { renderAsync } from "@resvg/resvg-js";
import { describe, expect, it } from "@rstest/core";
import { RENDER_FONT_OPTIONS, svgToPng } from "./rasterize.js";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">' +
  '<rect width="1200" height="630" fill="#f3c4bd"/>' +
  '<text x="96" y="300" font-family="Noto Sans, Helvetica, Arial, sans-serif" font-size="64">Hello 你好</text></svg>';

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

  it("actually draws text with the configured fonts", async () => {
    // A font set that resolves nothing renders an empty card with no error, so
    // count dark pixels instead of trusting the dimensions.
    const image = await renderAsync(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">' +
        '<rect width="400" height="100" fill="#fff"/>' +
        '<text x="10" y="60" font-family="Noto Sans, Helvetica, Arial, sans-serif" font-size="48" fill="#000">Hello 你好</text></svg>',
      { font: RENDER_FONT_OPTIONS },
    );
    const px = image.pixels;
    let dark = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 128) dark += 1;
    expect(dark).toBeGreaterThan(500);
  });
});
