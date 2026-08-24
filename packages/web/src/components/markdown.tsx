"use client";

import { type ComponentPropsWithoutRef, memo } from "react";
import { Link } from "react-router-dom";
import {
  MARKDOWN_LINK_CLASS,
  Markdown as BaseMarkdown,
  type MarkdownLinkProps,
  type MarkdownProps,
  type MarkdownTheme,
} from "@rome-os/ui/markdown";
import { useTheme } from "../hooks/use-theme";
import { isInternalHref, toInternalPath } from "../lib/internal-href";
import type { ResolvedTheme, ThemeName } from "../lib/theme";

export { MARKDOWN_LINK_CLASS };
export type { MarkdownLinkProps, MarkdownProps };

// The dashboard currently ships exactly these six theme/mode combinations.
// Keep Mermaid on explicit sRGB values: Mermaid's color parser cannot consume
// the OKLCH primitives used by Slate and the dark modes.
const BUILTIN_MERMAID_THEMES: Record<
  "ember" | "ash" | "slate",
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
};

export function getBuiltinMermaidTheme(
  theme: ThemeName,
  resolved: ResolvedTheme,
): MarkdownTheme | undefined {
  if (theme !== "ember" && theme !== "ash" && theme !== "slate") return undefined;
  return BUILTIN_MERMAID_THEMES[theme][resolved];
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
  if (isInternalHref(href)) {
    return (
      <Link to={toInternalPath(href)} className={MARKDOWN_LINK_CLASS} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={MARKDOWN_LINK_CLASS}
      {...(rest as ComponentPropsWithoutRef<"a">)}
    >
      {children}
    </a>
  );
}

function MarkdownImpl({ linkComponent, theme: themeOverride, ...props }: MarkdownProps) {
  const { theme, resolved } = useTheme();
  return (
    <BaseMarkdown
      {...props}
      linkComponent={linkComponent ?? MarkdownLink}
      theme={themeOverride ?? getBuiltinMermaidTheme(theme, resolved)}
    />
  );
}

const Markdown = memo(MarkdownImpl);
export default Markdown;
