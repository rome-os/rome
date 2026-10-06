// VENDORED VERBATIM from rome-internal:
//   packages/web/src/components/chat/entries/MermaidBlock.tsx
// Only the import lines are adapted (see ../VENDOR.md "seams"):
//   - "@/hooks/use-theme"  -> ../shims/use-theme
// The component body below is unchanged. Renders Mermaid diagrams to SVG via the
// synchronous `beautiful-mermaid` renderer (an app dependency).
import { useMemo } from "react";
import { renderMermaidSVG, THEMES } from "beautiful-mermaid";
import { useTheme } from "../shims/use-theme";

const THEME_MAP = {
  light: THEMES["github-light"],
  dark: THEMES["github-dark"],
} as const;

export function MermaidBlock({ code, compact = false }: { code: string; compact?: boolean }) {
  const { resolved } = useTheme();
  const theme = THEME_MAP[resolved];

  const result = useMemo(() => {
    try {
      return { svg: renderMermaidSVG(code, { ...theme, transparent: true }) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Failed to render diagram" };
    }
  }, [code, theme]);

  if (result.error) {
    const padding = compact ? "px-2.5 py-1.5" : "px-5 py-3";
    const margin = compact ? "my-2" : "my-3";
    const text = compact ? "text-xs leading-5" : "text-sm leading-6";
    return (
      <div className={`${margin}`}>
        <div className="mb-1 text-xs text-muted-foreground">Invalid Mermaid syntax</div>
        <pre
          className={`overflow-x-auto whitespace-pre-wrap break-words rounded-12 bg-surface-muted ${padding} font-mono ${text} text-foreground`}
        >
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  const margin = compact ? "my-2" : "my-3";
  return (
    <div
      className={`${margin} overflow-x-auto [&_svg]:max-w-full`}
      dangerouslySetInnerHTML={{ __html: result.svg! }}
    />
  );
}
