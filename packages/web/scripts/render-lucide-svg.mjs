// Renders a lucide glyph to standalone SVG markup with the dashboard's own
// `lucide-react`, so a file served as an image draws exactly what the
// component does. `scripts/check-icon-set.mjs` writes and checks the tool
// icons with it.

import * as lucide from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** The glyph named `glyph` as an SVG document stroked in `color`. */
export function renderLucideSvg(glyph, color) {
  const Icon = lucide[glyph];
  if (!Icon) throw new Error(`lucide-react has no icon named ${glyph}`);
  // Only the root's size and class go: a child <rect> needs its own width and height.
  const markup = renderToStaticMarkup(createElement(Icon, { color })).replace(
    /^<svg[^>]*>/,
    (root) => root.replace(/ (width|height|class)="[^"]*"/g, ""),
  );
  return `${markup}\n`;
}
