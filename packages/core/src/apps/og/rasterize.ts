import { renderAsync } from "@resvg/resvg-js";

/**
 * SVG → PNG at the SVG's own size, rendered on resvg's thread pool so a boot
 * that replays every installed app never blocks the event loop. System fonts
 * only: the container image installs Noto (Latin, CJK, emoji) and dev hosts
 * have their own; nothing is bundled here.
 */
export async function svgToPng(svg: string): Promise<Buffer> {
  const image = await renderAsync(svg, {
    font: { loadSystemFonts: true },
    fitTo: { mode: "width", value: 1200 },
  });
  return image.asPng();
}
