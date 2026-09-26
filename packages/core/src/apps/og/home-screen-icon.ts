import type { ResolvedApp } from "../state.js";
import { svgToPng } from "./rasterize.js";
import { readIcon } from "./subscriber.js";
import type { OgIcon } from "./template.js";

/** Side of the square home-screen icon: Android's install size; iOS scales it down. */
export const HOME_SCREEN_ICON_SIZE = 512;

/**
 * The icon filling an opaque white square. White because iOS fills
 * transparent pixels with black; unpadded and square because app icons are
 * already drawn as tiles and both platforms round the corners themselves.
 */
export function renderHomeScreenIconSvg(icon: OgIcon): string {
  const size = HOME_SCREEN_ICON_SIZE;
  const href = `data:${icon.mime};base64,${icon.bytes.toString("base64")}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
    `<image width="${size}" height="${size}" href="${href}" preserveAspectRatio="xMidYMid meet"/>`,
    "</svg>",
  ].join("");
}

/** The app's home-screen icon as a PNG, or null when it has no drawable icon. */
export async function renderHomeScreenIcon(app: ResolvedApp): Promise<Buffer | null> {
  const icon = await readIcon(app);
  if (icon === null) return null;
  // No fonts: loading the system fonts takes seconds on a host with many
  // installed, the render itself a few milliseconds, and resvg never draws
  // text inside an embedded <image> SVG anyway.
  return svgToPng(renderHomeScreenIconSvg(icon), HOME_SCREEN_ICON_SIZE, false);
}
