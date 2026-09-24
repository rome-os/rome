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
 * SVG → PNG `width` pixels wide (the card's 1200 by default), rendered on
 * resvg's thread pool so a boot that replays every installed app never blocks
 * the event loop. `withFonts: false` skips loading the system fonts, which
 * dominates the render time; only an SVG with no text may pass it.
 */
export async function svgToPng(svg: string, width = 1200, withFonts = true): Promise<Buffer> {
  const image = await renderAsync(svg, {
    font: withFonts ? RENDER_FONT_OPTIONS : { loadSystemFonts: false },
    fitTo: { mode: "width", value: width },
  });
  return image.asPng();
}
