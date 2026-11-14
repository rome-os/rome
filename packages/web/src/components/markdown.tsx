"use client";

import { type ComponentPropsWithoutRef, memo } from "react";
import { Link } from "react-router-dom";
import {
  MARKDOWN_LINK_CLASS,
  Markdown as BaseMarkdown,
  markdownLinkLabel,
  type MarkdownLinkProps,
  type MarkdownProps,
  type MarkdownTheme,
} from "@rome-os/ui/markdown";
import { useTheme } from "../hooks/use-theme";
import { isInternalHref, toInternalPath } from "../lib/internal-href";
import { transformMarkdownUrl } from "../lib/markdown-url";
import type { ResolvedTheme, ThemeName } from "../lib/theme";

export { MARKDOWN_LINK_CLASS };
export type { MarkdownLinkProps, MarkdownProps };

// The dashboard currently ships exactly these fourteen theme/mode combinations.
// Keep diagrams on explicit sRGB values: the Markdown theme resolver converts
// computed colors to hex and cannot read the OKLCH primitives used by Slate and
// the dark modes.
type BuiltinMermaidThemeName = "ember" | "ash" | "slate" | "sky" | "mint" | "lavender" | "blossom";

const BUILTIN_MERMAID_THEMES: Record<
  BuiltinMermaidThemeName,
  Record<ResolvedTheme, MarkdownTheme>
> = {
  ember: {
    light: {
      tokens: {
        foreground: "#1a130f",
        surface: "#fdfcf9",
        surfaceMuted: "#efe9e1",
        primary: "#d86f4c",
        line: "#8a7868",
      },
    },
    dark: {
      tokens: {
        foreground: "#f4f3ef",
        surface: "#14110f",
        surfaceMuted: "#1c1916",
        primary: "#d86f4c",
        line: "#b0a294",
      },
    },
  },
  // Ash shares Ember's dark half, so only the light tokens differ: neutral
  // surfaces, the deepened coral primary, and the darker muted ink.
  ash: {
    light: {
      tokens: {
        foreground: "#1a130f",
        surface: "#fefdfb",
        surfaceMuted: "#f5f4f1",
        primary: "#c05433",
        line: "#7a6857",
      },
    },
    dark: {
      tokens: {
        foreground: "#f4f3ef",
        surface: "#14110f",
        surfaceMuted: "#1c1916",
        primary: "#d86f4c",
        line: "#b0a294",
      },
    },
  },
  slate: {
    light: {
      tokens: {
        foreground: "#0a0a0a",
        surface: "#ffffff",
        surfaceMuted: "#f5f5f5",
        primary: "#121212",
        line: "#737373",
      },
    },
    dark: {
      tokens: {
        foreground: "#fafafa",
        surface: "#121212",
        surfaceMuted: "#181818",
        primary: "#fafafa",
        line: "#a1a1a1",
      },
    },
  },
  // The pastel themes share one mapping, modeled on Ash: their own near-neutral
  // ramp and accent ramp read at the same steps — canvas ink, card, muted fill,
  // `primary` and the muted line step.
  sky: {
    light: {
      tokens: {
        foreground: "#131416",
        surface: "#fdfdfe",
        surfaceMuted: "#f3f4f7",
        primary: "#41779e",
        line: "#626366",
      },
    },
    dark: {
      tokens: {
        foreground: "#f9fafd",
        surface: "#111213",
        surfaceMuted: "#18191b",
        primary: "#b0dcfe",
        line: "#b7b9bb",
      },
    },
  },
  mint: {
    light: {
      tokens: {
        foreground: "#121415",
        surface: "#fbfefe",
        surfaceMuted: "#f1f5f5",
        primary: "#417c6c",
        line: "#616464",
      },
    },
    dark: {
      tokens: {
        foreground: "#f7fbfc",
        surface: "#101213",
        surfaceMuted: "#171a1a",
        primary: "#a2e7d2",
        line: "#b6b9ba",
      },
    },
  },
  lavender: {
    light: {
      tokens: {
        foreground: "#131416",
        surface: "#fdfdfe",
        surfaceMuted: "#f3f4f7",
        primary: "#6d68a9",
        line: "#636365",
      },
    },
    dark: {
      tokens: {
        foreground: "#f9fafd",
        surface: "#111113",
        surfaceMuted: "#19191b",
        primary: "#d9d8fe",
        line: "#b8b8bb",
      },
    },
  },
  blossom: {
    light: {
      tokens: {
        foreground: "#131416",
        surface: "#fdfdfe",
        surfaceMuted: "#f3f4f7",
        primary: "#985c77",
        line: "#636365",
      },
    },
    dark: {
      tokens: {
        foreground: "#f9fafd",
        surface: "#111113",
        surfaceMuted: "#19191b",
        primary: "#fecce1",
        line: "#b8b8bb",
      },
    },
  },
};

export function getBuiltinMermaidTheme(
  theme: ThemeName,
  resolved: ResolvedTheme,
): MarkdownTheme | undefined {
  if (!Object.hasOwn(BUILTIN_MERMAID_THEMES, theme)) return undefined;
  return BUILTIN_MERMAID_THEMES[theme as BuiltinMermaidThemeName][resolved];
}

// Web-dashboard Markdown uses the shared renderer, but keeps in-app hrefs on
// react-router navigation. Chat can still override this through linkComponent.
export function MarkdownLink({
  children,
  href,
  node: _node,
  target: _target,
  rel: _rel,
  className: _className,
  ref: _ref,
  ...rest
}: MarkdownLinkProps) {
  const { label, full } = markdownLinkLabel(children);
  if (isInternalHref(href)) {
    return (
      <Link to={toInternalPath(href)} className={MARKDOWN_LINK_CLASS} title={full} {...rest}>
        {label}
      </Link>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={MARKDOWN_LINK_CLASS}
      title={full}
      {...(rest as ComponentPropsWithoutRef<"a">)}
    >
      {label}
    </a>
  );
}

function MarkdownImpl({
  linkComponent,
  theme: themeOverride,
  urlTransform,
  ...props
}: MarkdownProps) {
  const { theme, resolved } = useTheme();
  return (
    <BaseMarkdown
      {...props}
      linkComponent={linkComponent ?? MarkdownLink}
      theme={themeOverride ?? getBuiltinMermaidTheme(theme, resolved)}
      urlTransform={urlTransform ?? transformMarkdownUrl}
    />
  );
}

const Markdown = memo(MarkdownImpl);
export default Markdown;
