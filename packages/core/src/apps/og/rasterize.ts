import { renderAsync } from "@resvg/resvg-js";

/**
 * Font sources for the card. `loadSystemFonts` alone finds nothing on the
 * Debian images (no fontconfig), while the Noto packages live under
 * /usr/share/fonts, so those directories are named explicitly; resvg ignores
 * directories that do not exist, which keeps the same list valid on dev hosts
 * that only have system fonts. Nothing is bundled.
 */
export const RENDER_FONT_OPTIONS = {
  loadSystemFonts: true,
  fontDirs: ["/usr/share/fonts", "/usr/local/share/fonts"],
};

/**
 * SVG → PNG at the SVG's own size, rendered on resvg's thread pool so a boot
 * that replays every installed app never blocks the event loop.
 */
export async function svgToPng(svg: string): Promise<Buffer> {
  const image = await renderAsync(svg, {
    font: RENDER_FONT_OPTIONS,
    fitTo: { mode: "width", value: 1200 },
  });
  return image.asPng();
}
