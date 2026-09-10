import { Resvg } from "@resvg/resvg-js";

/**
 * SVG → PNG at the SVG's own size. System fonts only: the container image
 * installs Noto (Latin, CJK, emoji) and dev hosts have their own; nothing is
 * bundled here.
 */
export function svgToPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    font: { loadSystemFonts: true },
    fitTo: { mode: "width", value: 1200 },
  });
  return Buffer.from(resvg.render().asPng());
}
