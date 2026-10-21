// Mermaid diagrams for Streamdown, rendered by Pele instead of mermaid.js.
// Pele parses Mermaid syntax and lays it out itself, synchronously and without
// a DOM, and colors the SVG through `--pele-*` custom properties rather than
// Mermaid's themeVariables. The plugin keeps Streamdown's Mermaid contract,
// so callers still pass a Mermaid config and this file translates it.

import { renderAsync } from "pele/lazy";
import type { DiagramPlugin, MermaidOptions } from "streamdown";

type MermaidConfig = NonNullable<MermaidOptions["config"]>;

// Pele has its own palette slots, so each one reads the Mermaid variables that
// play the same part, in order of preference.
const PELE_VARIABLES: Record<string, readonly string[]> = {
  "--pele-bg": ["background", "edgeLabelBackground", "mainBkg"],
  "--pele-fg": ["primaryTextColor", "textColor"],
  "--pele-muted": ["lineColor", "secondaryTextColor"],
  "--pele-line": ["lineColor"],
  "--pele-surface": ["primaryColor", "mainBkg"],
  "--pele-surface-alt": ["secondaryColor", "clusterBkg", "tertiaryColor"],
  "--pele-border": ["primaryBorderColor", "clusterBorder"],
  "--pele-accent": ["activationBkgColor", "primaryBorderColor"],
};

// A value lands inside the SVG's style attribute, so anything that could end
// the declaration is refused and quotes are escaped for the attribute.
const UNSAFE_CSS_VALUE = /[;<>{}\\]/;

function cssValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || UNSAFE_CSS_VALUE.test(trimmed)) return undefined;
  return trimmed.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/** Translates a Mermaid config into the `--pele-*` declarations it implies. */
export function peleThemeDeclarations(config: MermaidConfig | undefined): string {
  const variables = (config?.themeVariables ?? {}) as Record<string, unknown>;
  const declarations: string[] = [];
  for (const [property, keys] of Object.entries(PELE_VARIABLES)) {
    const value = keys.map((key) => cssValue(variables[key])).find(Boolean);
    if (value) declarations.push(`${property}:${value}`);
  }
  return declarations.join(";");
}

// The palette goes on the SVG itself rather than on a parent, so a downloaded
// SVG or PNG keeps the colors it was shown with.
function applyTheme(svg: string, declarations: string): string {
  if (!declarations) return svg;
  // A callback keeps `$1` or `$&` inside a theme value literal.
  return svg.replace(
    /^<svg\b([^>]*?)\bstyle="/,
    (_, attributes: string) => `<svg${attributes}style="${declarations};`,
  );
}

function createRenderer(initial: MermaidConfig | undefined) {
  let config = initial;
  return {
    initialize(next: MermaidConfig) {
      config = next;
    },
    async render(id: string, source: string) {
      const font = config?.fontFamily;
      const { svg } = await renderAsync(source, {
        // Streamdown makes each id unique, and Pele prefixes the SVG's internal
        // ids with it, so markers and gradients of two diagrams never collide.
        idPrefix: id,
        // Pele escapes the font itself and uses it where --pele-font is unset.
        ...(font ? { fontFamily: font } : {}),
      });
      return { svg: applyTheme(svg, peleThemeDeclarations(config)) };
    },
  };
}

export const diagram: DiagramPlugin = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid(config) {
    return createRenderer(config);
  },
};
