// VENDORED from rome-internal:
//   packages/web/src/components/markdown.tsx
// Adapted seams (see ../VENDOR.md):
//   - dropped the `"use client"` directive (not a Next.js app)
//   - "react-router-dom" Link -> plain <a> (the static viewer has no SPA router)
//   - "@/components/chat/entries/MermaidBlock" -> ./MermaidBlock (vendored)
// Everything else (GFM, Mermaid, prose classes, code/link/table styling) is
// unchanged.
import {
  isValidElement,
  memo,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactElement,
} from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidBlock } from "./MermaidBlock";

const REMARK_PLUGINS = [remarkGfm];

function isInternalHref(href: string | undefined): href is string {
  if (!href) return false;
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  if (href.startsWith("#") || href.startsWith("?")) return true;
  if (typeof window !== "undefined") {
    try {
      const url = new URL(href, window.location.href);
      return url.origin === window.location.origin;
    } catch {
      return false;
    }
  }
  return false;
}

function toInternalPath(href: string): string {
  if (href.startsWith("/") || href.startsWith("#") || href.startsWith("?")) return href;
  try {
    const url = new URL(href, window.location.href);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}

interface MarkdownProps {
  children: string;
  className?: string;
  compact?: boolean;
  preserveSoftBreaks?: boolean;
}

function CodeBlock({
  children,
  className = "",
  node: _node,
  compact = false,
  ...props
}: ComponentPropsWithoutRef<"pre"> & { node?: unknown; compact?: boolean }) {
  const padding = compact ? "px-2.5 py-1.5" : "px-5 py-3";
  const margin = compact ? "my-2" : "my-3";
  const text = compact ? "text-xs leading-5" : "text-sm leading-6";
  return (
    <pre
      className={`${margin} overflow-x-auto whitespace-pre-wrap break-words rounded-12 bg-surface-muted ${padding} font-mono ${text} text-foreground [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit ${className}`}
      {...props}
    >
      {children}
    </pre>
  );
}

function MarkdownImpl({
  children,
  className = "",
  compact = false,
  preserveSoftBreaks = false,
}: MarkdownProps) {
  const wrapperClass = compact
    ? `prose prose-sm dark:prose-invert max-w-none break-words [&_*]:break-words [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:mt-2 [&_h3]:mb-1 [&_h4]:text-xs [&_h4]:font-semibold [&_h4]:mt-1.5 [&_h4]:mb-0.5 ${className}`
    : `prose prose-sm dark:prose-invert max-w-none break-words [&_*]:break-words ${className}`;
  const paragraphClass = [
    compact ? "mb-1.5 text-xs last:mb-0" : "mb-2 last:mb-0",
    preserveSoftBreaks ? "whitespace-pre-wrap" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const components = useMemo<Components>(
    () => ({
      a: ({ children, href, node: _node, ...props }) => {
        if (isInternalHref(href)) {
          return (
            <a href={toInternalPath(href)} {...props}>
              {children}
            </a>
          );
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
            {children}
          </a>
        );
      },
      code: ({ children, className = "", node: _node, ...props }) => (
        <code
          className={`rounded-4 bg-surface-muted px-1.5 py-0.5 font-mono text-[0.92em] font-normal text-foreground before:content-none after:content-none ${className}`}
          {...props}
        >
          {children}
        </code>
      ),
      p: ({ children }) => <p className={paragraphClass}>{children}</p>,
      li: ({ children, className = "", node: _node, ...props }) => (
        <li
          className={[preserveSoftBreaks ? "whitespace-pre-wrap" : "", className]
            .filter(Boolean)
            .join(" ")}
          {...props}
        >
          {children}
        </li>
      ),
      hr: () => <div className={compact ? "!my-2" : "!my-3"} />,
      pre: (props) => {
        const child = props.children;
        if (isValidElement(child)) {
          const childProps = (child as ReactElement<{ className?: string; children?: unknown }>)
            .props;
          if (
            typeof childProps.className === "string" &&
            childProps.className.includes("language-mermaid")
          ) {
            const code = String(childProps.children ?? "");
            return <MermaidBlock code={code} compact={compact} />;
          }
        }
        return <CodeBlock {...props} compact={compact} />;
      },
      table: ({ children, node: _node, ...props }) => (
        <div className="my-3 overflow-x-auto overscroll-x-contain">
          <table {...props}>{children}</table>
        </div>
      ),
    }),
    [paragraphClass, preserveSoftBreaks, compact],
  );
  return (
    <div className={wrapperClass}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

const Markdown = memo(MarkdownImpl);
export default Markdown;
