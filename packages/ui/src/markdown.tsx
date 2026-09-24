"use client";

import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid, type MermaidConfig } from "@streamdown/mermaid";
import {
  memo,
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
} from "react";
import { Streamdown, type Components, type MermaidOptions, type StreamdownProps } from "streamdown";
import { cn } from "./cn.js";

export type { Components, MermaidConfig, MermaidOptions, StreamdownProps };

export const MARKDOWN_LINK_CLASS = "wrap-anywhere text-primary underline";

export type MarkdownLinkProps = ComponentPropsWithoutRef<"a"> & {
  node?: unknown;
  ref?: unknown;
};

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
  const external = shouldOpenInNewTab(href);
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className={MARKDOWN_LINK_CLASS}
      {...rest}
    >
      {children}
    </a>
  );
}

type MarkdownHeadingProps = ComponentPropsWithoutRef<"h1"> & { node?: unknown };

function MarkdownHeading1({ node: _node, ...props }: MarkdownHeadingProps) {
  return <h1 {...props} data-streamdown="heading-1" />;
}

function MarkdownHeading2({ node: _node, ...props }: MarkdownHeadingProps) {
  return <h2 {...props} data-streamdown="heading-2" />;
}

function MarkdownHeading3({ node: _node, ...props }: MarkdownHeadingProps) {
  return <h3 {...props} data-streamdown="heading-3" />;
}

function MarkdownHeading4({ node: _node, ...props }: MarkdownHeadingProps) {
  return <h4 {...props} data-streamdown="heading-4" />;
}

function MarkdownHeading5({ node: _node, ...props }: MarkdownHeadingProps) {
  return <h5 {...props} data-streamdown="heading-5" />;
}

function MarkdownHeading6({ node: _node, ...props }: MarkdownHeadingProps) {
  return <h6 {...props} data-streamdown="heading-6" />;
}

function shouldOpenInNewTab(href: string | undefined): boolean {
  if (!href) return false;

  const explicitHttp = /^https?:\/\//i.test(href);
  const protocolRelative = href.startsWith("//");
  if (!explicitHttp && !protocolRelative) return false;

  if (typeof window === "undefined") return true;

  try {
    return new URL(href, window.location.href).origin !== window.location.origin;
  } catch {
    return false;
  }
}

export interface MarkdownThemeTokens {
  fontFamily: string | readonly string[];
  foreground: string | readonly string[];
  surface: string | readonly string[];
  surfaceMuted: string | readonly string[];
  primary: string | readonly string[];
  line: string | readonly string[];
}

export interface MarkdownTheme {
  /**
   * Element whose CSS custom properties should seed the generated Mermaid
   * theme. Defaults to document.documentElement. Mounted instances re-resolve
   * the theme when the root's `class`, `data-theme`, or `style` attribute
   * changes. Changes elsewhere, such as on an ancestor or in a stylesheet, do
   * not reach them.
   */
  root?: Element | null;
  /**
   * CSS variables or literal CSS values used to derive the default Mermaid
   * theme. CSS variable names may be passed as "--foreground" or "var(...)";
   * literal colors and font stacks are accepted too.
   */
  tokens?: Partial<MarkdownThemeTokens>;
  /**
   * Final Mermaid config overrides. These are merged over the generated base
   * theme, including themeVariables.
   */
  mermaid?: MermaidConfig;
}

export interface MarkdownProps {
  children: string;
  className?: string;
  /** Rebind Markdown typography and rhythm tokens to their dense values. */
  compact?: boolean;
  preserveSoftBreaks?: boolean;
  inlineCodeComponent?: Components["inlineCode"];
  linkComponent?: Components["a"];
  preComponent?: Components["pre"];
  theme?: MarkdownTheme;
  controls?: StreamdownProps["controls"];
  lineNumbers?: StreamdownProps["lineNumbers"];
}

const STREAMDOWN_PLUGINS = { code, math, mermaid };

const DEFAULT_TOKENS: MarkdownThemeTokens = {
  fontFamily: ["--font-sans"],
  foreground: ["--foreground"],
  surface: ["--surface", "--card", "--background"],
  surfaceMuted: ["--surface-muted", "--muted", "--card", "--background"],
  primary: ["--primary"],
  line: ["--muted-foreground", "--border", "--foreground"],
};

interface MermaidTheme {
  fontFamily: string;
  themeVariables: Record<string, string>;
}

function cssVar(value: string): string {
  return value.startsWith("--") ? `var(${value})` : value;
}

function firstTokenValue(root: Element, token: string | readonly string[]): string {
  const values = Array.isArray(token) ? token : [token];
  for (const value of values) {
    if (!value.startsWith("--")) return value;
    const resolved = getComputedStyle(root).getPropertyValue(value).trim();
    if (resolved) return `var(${value})`;
  }
  return values[0] ?? "";
}

function rgbToHex(color: string): string {
  const parts = color.match(/[\d.]+/g)?.map(Number);
  if (!parts || parts.length < 3) return color;
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  const [r, g, b, a] = parts;
  const base = `#${hex(r)}${hex(g)}${hex(b)}`;
  return a === undefined || a >= 1 ? base : `${base}${hex(a * 255)}`;
}

function resolveColor(root: Element, value: string | readonly string[]): string {
  if (typeof document === "undefined") {
    return typeof value === "string" ? value : (value[0] ?? "");
  }
  const raw = firstTokenValue(root, value);
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = cssVar(raw);
  root.appendChild(probe);
  try {
    return rgbToHex(getComputedStyle(probe).color);
  } finally {
    probe.remove();
  }
}

function resolveFontFamily(root: Element, value: string | readonly string[]): string {
  const raw = firstTokenValue(root, value);
  if (!raw.startsWith("var(")) return raw;
  const varName = raw.slice(4, -1).trim();
  return getComputedStyle(root).getPropertyValue(varName).trim();
}

function getThemeRoot(theme?: MarkdownTheme): Element | null {
  if (theme?.root !== undefined) return theme.root;
  if (typeof document === "undefined") return null;
  return document.documentElement;
}

export function readMarkdownMermaidTheme(theme?: MarkdownTheme): MermaidTheme {
  const root = getThemeRoot(theme);
  if (!root) return { fontFamily: "", themeVariables: {} };

  const tokens = { ...DEFAULT_TOKENS, ...theme?.tokens };
  const fontFamily = resolveFontFamily(root, tokens.fontFamily);
  const foreground = resolveColor(root, tokens.foreground);
  const surface = resolveColor(root, tokens.surface);
  const surfaceMuted = resolveColor(root, tokens.surfaceMuted);
  const primary = resolveColor(root, tokens.primary);
  const line = resolveColor(root, tokens.line);

  return {
    fontFamily,
    themeVariables: {
      fontFamily,
      mainBkg: surface,
      primaryColor: surface,
      primaryTextColor: foreground,
      primaryBorderColor: line,
      secondaryColor: surfaceMuted,
      secondaryTextColor: foreground,
      secondaryBorderColor: line,
      tertiaryColor: surfaceMuted,
      tertiaryTextColor: foreground,
      tertiaryBorderColor: line,
      lineColor: line,
      textColor: foreground,
      titleColor: foreground,
      actorLineColor: line,
      edgeLabelBackground: surface,
      clusterBkg: surfaceMuted,
      clusterBorder: line,
      noteBkgColor: surfaceMuted,
      noteTextColor: foreground,
      noteBorderColor: line,
      activationBkgColor: primary,
      activationBorderColor: primary,
    },
  };
}

const EMPTY_MERMAID_THEME: MermaidTheme = { fontFamily: "", themeVariables: {} };

const THEME_ROOT_ATTRIBUTES = ["class", "data-theme", "style"];

interface ResolvedMermaidTheme {
  theme: MermaidTheme;
  stale: boolean;
}

interface ThemeRootStore {
  byTokens: Map<string, ResolvedMermaidTheme>;
  listeners: Set<() => void>;
  observer: MutationObserver | null;
}

// Resolving a theme reads computed style, which forces a document-wide style
// recalc. Every mounted Markdown shares one resolution per root and token set,
// so a transcript with N messages pays one recalc on mount instead of 2N, each
// over a DOM that grows with every message rendered before it.
const themeRootStores = new WeakMap<Element, ThemeRootStore>();

function themeRootStore(root: Element): ThemeRootStore {
  let store = themeRootStores.get(root);
  if (!store) {
    store = { byTokens: new Map(), listeners: new Set(), observer: null };
    themeRootStores.set(root, store);
  }
  return store;
}

function subscribeToThemeRoot(root: Element, listener: () => void): () => void {
  const store = themeRootStore(root);
  store.listeners.add(listener);
  if (!store.observer && typeof MutationObserver !== "undefined") {
    // Entries resolved during render went unwatched until now, and a render
    // that never committed can leave one behind, so re-validate them once.
    for (const entry of store.byTokens.values()) entry.stale = true;
    const observer = new MutationObserver(() => {
      for (const entry of store.byTokens.values()) entry.stale = true;
      for (const notify of store.listeners) notify();
    });
    observer.observe(root, { attributes: true, attributeFilter: THEME_ROOT_ATTRIBUTES });
    store.observer = observer;
  }
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size > 0) return;
    // With nothing mounted, nothing watches the root, so the next mount
    // re-validates. Marking entries stale rather than dropping them keeps the
    // object for sameMermaidTheme, so instances that replace these in the same
    // commit are not re-rendered.
    store.observer?.disconnect();
    store.observer = null;
    for (const entry of store.byTokens.values()) entry.stale = true;
  };
}

function sameMermaidTheme(a: MermaidTheme, b: MermaidTheme): boolean {
  if (a.fontFamily !== b.fontFamily) return false;
  const keys = Object.keys(a.themeVariables);
  return (
    keys.length === Object.keys(b.themeVariables).length &&
    keys.every((key) => a.themeVariables[key] === b.themeVariables[key])
  );
}

function readSharedMermaidTheme(
  root: Element,
  tokensKey: string,
  theme: MarkdownTheme | undefined,
): MermaidTheme {
  const { byTokens } = themeRootStore(root);
  const cached = byTokens.get(tokensKey);
  if (cached && !cached.stale) return cached.theme;
  const next = readMarkdownMermaidTheme(theme);
  // A root mutation that leaves the resolved values unchanged keeps the old
  // object, so Streamdown sees equal props and every mounted block skips a
  // re-render.
  const resolved = cached && sameMermaidTheme(cached.theme, next) ? cached.theme : next;
  byTokens.set(tokensKey, { theme: resolved, stale: false });
  return resolved;
}

function useMarkdownMermaidTheme(theme?: MarkdownTheme): MermaidTheme {
  const root = getThemeRoot(theme);
  const tokensKey = JSON.stringify({ ...DEFAULT_TOKENS, ...theme?.tokens });
  const subscribe = useCallback(
    (listener: () => void) => (root ? subscribeToThemeRoot(root, listener) : () => {}),
    [root],
  );
  const getSnapshot = () =>
    root ? readSharedMermaidTheme(root, tokensKey, theme) : EMPTY_MERMAID_THEME;
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_MERMAID_THEME);
}

function mergeMermaidConfig(
  base: MermaidConfig,
  override: MermaidConfig | undefined,
): MermaidConfig {
  if (!override) return base;
  return {
    ...base,
    ...override,
    themeVariables: {
      ...base.themeVariables,
      ...override.themeVariables,
    },
    sequence: {
      ...base.sequence,
      ...override.sequence,
    },
  };
}

function MarkdownImpl({
  children,
  className = "",
  compact = false,
  preserveSoftBreaks = false,
  inlineCodeComponent,
  linkComponent,
  preComponent,
  theme,
  controls,
  lineNumbers,
}: MarkdownProps) {
  const { fontFamily, themeVariables } = useMarkdownMermaidTheme(theme);
  const mermaidOptions = useMemo<MermaidOptions>(() => {
    const baseConfig: MermaidConfig = {
      theme: "base",
      fontFamily,
      themeVariables,
      sequence: {
        actorFontFamily: fontFamily,
        messageFontFamily: fontFamily,
        noteFontFamily: fontFamily,
      },
    };
    return { config: mergeMermaidConfig(baseConfig, theme?.mermaid) };
  }, [fontFamily, themeVariables, theme?.mermaid]);

  const components = useMemo<Components>(
    () => ({
      a: linkComponent ?? MarkdownLink,
      h1: MarkdownHeading1,
      h2: MarkdownHeading2,
      h3: MarkdownHeading3,
      h4: MarkdownHeading4,
      h5: MarkdownHeading5,
      h6: MarkdownHeading6,
      ...(inlineCodeComponent ? { inlineCode: inlineCodeComponent } : {}),
      ...(preComponent ? { pre: preComponent } : {}),
    }),
    [inlineCodeComponent, linkComponent, preComponent],
  );

  const wrapperClass = cn(
    "rome-markdown",
    compact && "rome-markdown-compact",
    "break-words",
    preserveSoftBreaks && "[&_p]:whitespace-pre-wrap [&_li]:whitespace-pre-wrap",
    className,
  );

  return (
    <Streamdown
      className={wrapperClass}
      components={components}
      controls={controls}
      lineNumbers={lineNumbers}
      mermaid={mermaidOptions}
      plugins={STREAMDOWN_PLUGINS}
    >
      {children}
    </Streamdown>
  );
}

export const Markdown = memo(MarkdownImpl);
export default Markdown;
