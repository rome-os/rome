import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@rome-os/ui/cn";

/*
 * Markdown for journal entries, summaries, and saved skills, painted with the
 * host tokens. The kit's `Markdown` would match the chat page exactly, but its
 * code, math, and diagram plugins put this bundle at tens of megabytes for
 * text that is headings, lists, and the odd code span.
 */

const heading = "mt-5 mb-2 text-ui font-semibold text-foreground first:mt-0";

const components: Components = {
  h1: ({ node: _node, ...props }) => <h4 className={heading} {...props} />,
  h2: ({ node: _node, ...props }) => <h4 className={heading} {...props} />,
  h3: ({ node: _node, ...props }) => <h5 className={heading} {...props} />,
  h4: ({ node: _node, ...props }) => <h6 className={heading} {...props} />,
  p: ({ node: _node, ...props }) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  ul: ({ node: _node, ...props }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 marker:text-subtle-foreground" {...props} />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground" {...props} />
  ),
  li: ({ node: _node, ...props }) => <li className="pl-1 [&>ul]:my-1 [&>ol]:my-1" {...props} />,
  a: ({ node: _node, href, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-4"
      {...props}
    />
  ),
  strong: ({ node: _node, ...props }) => (
    <strong className="font-semibold text-foreground" {...props} />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote
      className="my-2 border-l-2 border-border-strong pl-3 text-muted-foreground"
      {...props}
    />
  ),
  hr: () => <hr className="my-4 border-border-subtle" />,
  code: ({ node: _node, className, ...props }) => (
    <code
      className={cn(
        "rounded-4 bg-surface-muted px-1 py-0.5 font-mono text-aux text-foreground",
        className,
      )}
      {...props}
    />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      className="my-2 overflow-x-auto rounded-8 bg-surface-muted px-3 py-2 font-mono text-aux [&_code]:bg-transparent [&_code]:p-0"
      {...props}
    />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-left" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th className="border-b border-border px-2 py-1.5 font-medium text-foreground" {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="border-b border-border-subtle px-2 py-1.5 align-top" {...props} />
  ),
};

export function Prose({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("min-w-0 text-ui break-words text-foreground", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
